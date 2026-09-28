import { DateTime } from "luxon";
import { config } from "../config.js";
import { exec } from "../db.js";
import { fetchWorkDetail } from "./api/worksApiClient.js";
import { logger } from "./common/logger.js";
import { withTx } from "./common/tx.js";
import type { WorkItem, WorkProduct, WorkTag, WorkTask } from "../types/worksApi.js";

type WorkRef = {
  work_id: number;
  external_id: number;
};

type DetailResult = {
  ref: WorkRef;
  detail: WorkItem;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function toInt(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;

  const n = Number(text);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toDecimal(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;

  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function toMysqlDate(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;

  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];

  const dt = DateTime.fromISO(text, { setZone: true });
  if (dt.isValid) return dt.setZone(config.tz).toFormat("yyyy-LL-dd");

  return null;
}

function toMysqlDateTime(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;

  const fromIso = DateTime.fromISO(text, { setZone: true });
  if (fromIso.isValid) return fromIso.setZone(config.tz).toFormat("yyyy-LL-dd HH:mm:ss");

  const fromSql = DateTime.fromSQL(text, { zone: config.tz });
  if (fromSql.isValid) return fromSql.toFormat("yyyy-LL-dd HH:mm:ss");

  return text.slice(0, 19).replace("T", " ");
}

// delivery_note_date (fecha de envio) llega como fecha "YYYY-MM-DD"; como DATETIME queda a las 00:00:00.
function toMysqlDateTimeFromDateOnly(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`;
  return toMysqlDateTime(text);
}

function asArray<T>(value: T[] | null | undefined) {
  return Array.isArray(value) ? value : [];
}

function asJson(value: unknown) {
  return JSON.stringify(value ?? null);
}

function uniqueNumbers(values: Array<number | null>) {
  return [...new Set(values.filter((value): value is number => value !== null))];
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}

// Ordenes con detalle ya guardado que conviene volver a pedir:
// - el ETL del listado cambio status o finish_date en works (el detalle quedo viejo)
// - terminadas en los ultimos N dias y el detalle todavia no trae delivery_note_date (fecha de envio)
// - creadas en los ultimos N dias sin ninguna fecha estimada (ni en works ni en el detalle)
// Solo si el detalle se guardo hace mas de WORK_DETAILS_REFRESH_MIN_AGE_MINUTES, para no pedir la misma
// orden en cada vuelta si la API tarda en reflejar el cambio.
function refreshMinAge() {
  return Math.max(0, Math.trunc(config.workDetails.refreshMinAgeMinutes));
}

function refreshMissingDatesDays() {
  return Math.max(0, Math.trunc(config.workDetails.refreshMissingDatesDays));
}

function needsRefreshSql(): { sql: string; params: number[] } {
  const days = refreshMissingDatesDays();
  const reasons = ["NOT (w.status <=> ewd.status)", "NOT (w.finish_date <=> ewd.finish_date)"];
  const params: number[] = [];

  if (days > 0) {
    reasons.push("(ewd.delivery_note_date IS NULL AND w.finish_date >= CURDATE() - INTERVAL ? DAY)");
    params.push(days);
    reasons.push(
      "(w.estimated_delivery IS NULL AND ewd.estimated_delivery IS NULL AND w.created_at_api >= NOW() - INTERVAL ? DAY)"
    );
    params.push(days);
  }

  params.push(refreshMinAge());
  return {
    sql:
      `(${reasons.join(" OR ")}) ` +
      "AND (ewd.updated_at IS NULL OR ewd.updated_at < NOW() - INTERVAL ? MINUTE)",
    params,
  };
}

/**
 * Que ordenes toma cada pasada:
 * - all: todas (barrido o WORK_DETAILS_ONLY_MISSING=0)
 * - missing: sin fila en external_work_details (ordenes nuevas)
 * - stale: con detalle, pero hay que volver a pedirlo (ver needsRefreshSql)
 */
export type RefsFilter = "all" | "missing" | "stale";

export async function logPendingRefs() {
  const refresh = needsRefreshSql();
  const [row] = await exec<Array<{ missing: number | string | null; stale: number | string | null }>>(
    `
      SELECT
        SUM(ewd.external_work_detail_id IS NULL) AS missing,
        SUM(ewd.external_work_detail_id IS NOT NULL AND ${refresh.sql}) AS stale
      FROM works w
      LEFT JOIN external_work_details ewd ON ewd.work_external_id = w.external_id
      WHERE w.external_id IS NOT NULL
        AND w.external_id <> 0
        AND w.is_deleted = 0
    `,
    refresh.params
  );

  logger.info(
    `Work details ETL: por actualizar (cambio de estado / fechas faltantes)=${Number(row?.stale ?? 0)} ` +
      `sin detalle=${Number(row?.missing ?? 0)}`
  );
}

async function fetchNextWorkRefs(lastWorkId: number, limit: number, filter: RefsFilter) {
  const safeLimit = Math.max(1, Math.trunc(limit));
  const join =
    filter === "all" ? "" : "LEFT JOIN external_work_details ewd ON ewd.work_external_id = w.external_id";
  let where = "";
  let params: number[] = [lastWorkId];

  if (filter === "missing") {
    where = "AND ewd.external_work_detail_id IS NULL";
  } else if (filter === "stale") {
    const refresh = needsRefreshSql();
    where = `AND ewd.external_work_detail_id IS NOT NULL AND ${refresh.sql}`;
    params = [lastWorkId, ...refresh.params];
  }

  return exec<WorkRef[]>(
    `
      SELECT w.work_id, w.external_id
      FROM works w
      ${join}
      WHERE w.work_id > ?
        AND w.external_id IS NOT NULL
        AND w.external_id <> 0
        AND w.is_deleted = 0
        ${where}
      ORDER BY w.work_id ASC
      LIMIT ${safeLimit}
    `,
    params
  );
}

/**
 * Copia la fecha correcta a works.estimated_delivery para las ordenes recien guardadas:
 * fecha de envio del detalle (delivery_note_date); si no hay, se conserva la de works (listado);
 * si works tampoco tiene, la estimada del detalle. Solo toca las filas donde cambia.
 */
async function syncWorksEstimatedDelivery(workExternalIds: number[]) {
  if (!config.workDetails.syncWorksEstimatedDelivery || !workExternalIds.length) return 0;

  let changed = 0;
  for (const part of chunk(workExternalIds, 500)) {
    const result: any = await withTx(async (conn) => {
      const [res] = await conn.query(
        `
          UPDATE works w
          JOIN external_work_details d ON d.work_external_id = w.external_id
          SET w.estimated_delivery = COALESCE(d.delivery_note_date, w.estimated_delivery, d.estimated_delivery),
              w.updated_by = 'etl'
          WHERE w.external_id IN (?)
            AND NOT (w.estimated_delivery <=> COALESCE(d.delivery_note_date, w.estimated_delivery, d.estimated_delivery))
        `,
        [part]
      );
      return res;
    });
    changed += Number(result?.affectedRows ?? 0);
  }
  return changed;
}

async function upsertRows(
  conn: any,
  table: string,
  columns: string[],
  rows: any[][],
  updateColumns: string[],
  chunkSize = 500
) {
  if (!rows.length) return;

  const colsSql = columns.map((column) => `\`${column}\``).join(", ");
  const placeholdersRow = `(${columns.map(() => "?").join(",")})`;
  const updateSql = [
    ...updateColumns.map((column) => `\`${column}\` = VALUES(\`${column}\`)`),
    "`updated_at` = CURRENT_TIMESTAMP",
  ].join(", ");

  for (const part of chunk(rows, chunkSize)) {
    const sql = `
      INSERT INTO ${table} (${colsSql})
      VALUES ${part.map(() => placeholdersRow).join(",")}
      ON DUPLICATE KEY UPDATE ${updateSql}
    `;
    // [RAM] query (no prepared statement): el numero de filas cambia en cada lote
    await conn.query(sql, part.flat());
  }
}

async function insertRows(conn: any, table: string, columns: string[], rows: any[][], chunkSize = 500) {
  if (!rows.length) return;

  const colsSql = columns.map((column) => `\`${column}\``).join(", ");
  const placeholdersRow = `(${columns.map(() => "?").join(",")})`;

  for (const part of chunk(rows, chunkSize)) {
    const sql = `
      INSERT INTO ${table} (${colsSql})
      VALUES ${part.map(() => placeholdersRow).join(",")}
    `;
    // [RAM] query (no prepared statement): el numero de filas cambia en cada lote
    await conn.query(sql, part.flat());
  }
}

async function deleteChildrenForWorks(conn: any, table: string, workExternalIds: number[]) {
  for (const part of chunk(workExternalIds, 500)) {
    const placeholders = part.map(() => "?").join(",");
    // [RAM] query: el tamaño del IN (...) cambia en cada lote
    await conn.query(`DELETE FROM ${table} WHERE work_external_id IN (${placeholders})`, part);
  }
}

async function readIdMap(
  conn: any,
  table: string,
  idColumn: string,
  externalColumn: string,
  externalIds: number[]
) {
  const map = new Map<number, number>();
  if (!externalIds.length) return map;

  for (const part of chunk(externalIds, 500)) {
    const placeholders = part.map(() => "?").join(",");
    // [RAM] query: el tamaño del IN (...) cambia en cada lote
    const [rows] = await conn.query(
      `SELECT \`${idColumn}\`, \`${externalColumn}\` FROM ${table} WHERE \`${externalColumn}\` IN (${placeholders})`,
      part
    );

    for (const row of rows as any[]) {
      const externalId = toInt(row[externalColumn]);
      const localId = toInt(row[idColumn]);
      if (externalId !== null && localId !== null) map.set(externalId, localId);
    }
  }

  return map;
}

async function readManufacturerMap(conn: any, manufacturerExternalIds: number[]) {
  const map = new Map<string, number>();
  if (!manufacturerExternalIds.length) return map;

  for (const part of chunk(manufacturerExternalIds, 500)) {
    const placeholders = part.map(() => "?").join(",");
    // [RAM] query: el tamaño del IN (...) cambia en cada lote
    const [rows] = await conn.query(
      `
        SELECT external_manufacturer_id, manufacturer_type, manufacturer_external_id
        FROM external_manufacturers
        WHERE manufacturer_external_id IN (${placeholders})
      `,
      part
    );

    for (const row of rows as any[]) {
      const externalId = toInt(row.manufacturer_external_id);
      const localId = toInt(row.external_manufacturer_id);
      const type = cleanText(row.manufacturer_type) ?? "";
      if (externalId !== null && localId !== null) map.set(`${type}|${externalId}`, localId);
    }
  }

  return map;
}

function getWorkExternalId(result: DetailResult) {
  return toInt(result.detail.id) ?? result.ref.external_id;
}

function collectCatalogRows(results: DetailResult[]) {
  const stages = new Map<number, any[]>();
  const manufacturers = new Map<string, any[]>();
  const tags = new Map<number, any[]>();
  const products = new Map<number, any[]>();

  for (const result of results) {
    const detail = result.detail;

    for (const task of asArray<WorkTask>(detail.tasks)) {
      const stageExternalId = toInt(task.stage?.id);
      const stageName = cleanText(task.stage?.name);
      if (stageExternalId !== null && stageName) {
        stages.set(stageExternalId, [stageExternalId, stageName]);
      }

      const manufacturerExternalId = toInt(task.manufacturer?.id);
      const manufacturerName = cleanText(task.manufacturer?.name);
      const manufacturerType = cleanText(task.manufacturer?.type) ?? "UNKNOWN";
      if (manufacturerExternalId !== null && manufacturerName) {
        manufacturers.set(`${manufacturerType}|${manufacturerExternalId}`, [
          manufacturerExternalId,
          manufacturerType,
          manufacturerName,
        ]);
      }
    }

    for (const tag of asArray<WorkTag>(detail.tags)) {
      const tagExternalId = toInt(tag.id);
      const tagName = cleanText(tag.name);
      if (tagExternalId !== null && tagName) {
        tags.set(tagExternalId, [tagExternalId, cleanText(tag.code), tagName]);
      }
    }

    for (const productLine of asArray<WorkProduct>(detail.products)) {
      const productExternalId = toInt(productLine.product?.id);
      const productName = cleanText(productLine.product?.name);
      if (productExternalId !== null && productName) {
        products.set(productExternalId, [
          productExternalId,
          cleanText(productLine.product?.code),
          productName,
        ]);
      }
    }
  }

  return {
    stageRows: [...stages.values()],
    manufacturerRows: [...manufacturers.values()],
    tagRows: [...tags.values()],
    productRows: [...products.values()],
  };
}

async function persistDetails(results: DetailResult[]) {
  if (!results.length) return;

  const workExternalIds = uniqueNumbers(results.map(getWorkExternalId));
  if (!workExternalIds.length) return;

  await withTx(async (conn) => {
    const detailRows = results.map(({ ref, detail }) => {
      const workExternalId = getWorkExternalId({ ref, detail });

      return [
        ref.work_id,
        workExternalId,
        cleanText(detail.code),
        cleanText(detail.box),
        toMysqlDateTime(detail.created_at),
        toMysqlDate(detail.order_date),
        toMysqlDate(detail.accept_date),
        // estimated_delivery: manda delivery_note_date (fecha de envio); si aun no hay, la estimada de la API
        toMysqlDateTimeFromDateOnly(detail.delivery_note_date) ?? toMysqlDateTime(detail.estimated_delivery),
        toMysqlDateTime(detail.deadline),
        toMysqlDate(detail.finish_date),
        toMysqlDate(detail.delivery_note_date),
        cleanText(detail.status),
        cleanText(detail.status_name),
        toInt(detail.clinic?.id ?? detail.clinic_id),
        cleanText(detail.clinic?.code),
        cleanText(detail.clinic?.name),
        toInt(detail.doctor?.id ?? detail.doctor_id),
        cleanText(detail.doctor?.name),
        cleanText(detail.patient?.name ?? detail.patient_name),
        toInt(detail.patient?.age),
        cleanText(detail.patient?.sex),
        cleanText(detail.patient?.sex_name),
        cleanText(detail.observations),
        cleanText(detail.internal_notes),
        toDecimal(detail.total_price),
        toDecimal(detail.total_price_with_vat),
        asJson(detail),
        1,
        0,
      ];
    });

    await upsertRows(
      conn,
      "external_work_details",
      [
        "work_id",
        "work_external_id",
        "code",
        "box",
        "created_at_api",
        "order_date",
        "accepted_date",
        "estimated_delivery",
        "deadline",
        "finish_date",
        "delivery_note_date",
        "status",
        "status_name",
        "clinic_external_id",
        "clinic_code",
        "clinic_name",
        "doctor_external_id",
        "doctor_name",
        "patient_name",
        "patient_age",
        "patient_sex",
        "patient_sex_name",
        "observations",
        "internal_notes",
        "total_price",
        "total_price_with_vat",
        "raw_json",
        "is_active",
        "is_deleted",
      ],
      detailRows,
      [
        "work_id",
        "code",
        "box",
        "created_at_api",
        "order_date",
        "accepted_date",
        "estimated_delivery",
        "deadline",
        "finish_date",
        "delivery_note_date",
        "status",
        "status_name",
        "clinic_external_id",
        "clinic_code",
        "clinic_name",
        "doctor_external_id",
        "doctor_name",
        "patient_name",
        "patient_age",
        "patient_sex",
        "patient_sex_name",
        "observations",
        "internal_notes",
        "total_price",
        "total_price_with_vat",
        "raw_json",
        "is_active",
        "is_deleted",
      ]
    );

    const { stageRows, manufacturerRows, tagRows, productRows } = collectCatalogRows(results);

    await upsertRows(
      conn,
      "external_stages",
      ["stage_external_id", "name"],
      stageRows,
      ["name"]
    );

    await upsertRows(
      conn,
      "external_manufacturers",
      ["manufacturer_external_id", "manufacturer_type", "name"],
      manufacturerRows,
      ["manufacturer_type", "name"]
    );

    await upsertRows(
      conn,
      "external_tags",
      ["tag_external_id", "code", "name"],
      tagRows,
      ["code", "name"]
    );

    await upsertRows(
      conn,
      "external_products",
      ["product_external_id", "code", "name"],
      productRows,
      ["code", "name"]
    );

    const stageMap = await readIdMap(
      conn,
      "external_stages",
      "external_stage_id",
      "stage_external_id",
      uniqueNumbers(stageRows.map((row) => toInt(row[0])))
    );
    const manufacturerMap = await readManufacturerMap(
      conn,
      uniqueNumbers(manufacturerRows.map((row) => toInt(row[0])))
    );
    const tagMap = await readIdMap(
      conn,
      "external_tags",
      "external_tag_id",
      "tag_external_id",
      uniqueNumbers(tagRows.map((row) => toInt(row[0])))
    );
    const productMap = await readIdMap(
      conn,
      "external_products",
      "external_product_id",
      "product_external_id",
      uniqueNumbers(productRows.map((row) => toInt(row[0])))
    );

    await deleteChildrenForWorks(conn, "external_work_tasks", workExternalIds);
    await deleteChildrenForWorks(conn, "external_work_tags", workExternalIds);
    await deleteChildrenForWorks(conn, "external_work_products", workExternalIds);
    await deleteChildrenForWorks(conn, "external_work_lots", workExternalIds);

    const taskRows: any[][] = [];
    const workTagRows: any[][] = [];
    const workProductRows: any[][] = [];
    const workLotRows: any[][] = [];

    for (const result of results) {
      const workExternalId = getWorkExternalId(result);

      asArray<WorkTask>(result.detail.tasks).forEach((task, index) => {
        const taskExternalId = toInt(task.id);
        if (taskExternalId === null) return;

        const stageExternalId = toInt(task.stage?.id);
        const manufacturerExternalId = toInt(task.manufacturer?.id);
        const manufacturerType = cleanText(task.manufacturer?.type) ?? "UNKNOWN";

        taskRows.push([
          taskExternalId,
          result.ref.work_id,
          workExternalId,
          stageExternalId === null ? null : stageMap.get(stageExternalId) ?? null,
          stageExternalId,
          cleanText(task.stage?.name),
          manufacturerExternalId === null
            ? null
            : manufacturerMap.get(`${manufacturerType}|${manufacturerExternalId}`) ?? null,
          manufacturerExternalId,
          manufacturerExternalId === null ? cleanText(task.manufacturer?.type) : manufacturerType,
          cleanText(task.manufacturer?.name),
          cleanText(task.status),
          cleanText(task.status_name),
          toMysqlDateTime(task.start_date),
          toMysqlDateTime(task.finish_date),
          toMysqlDateTime(task.estimated_delivery),
          toInt(task.teeth_count),
          toDecimal(task.cost),
          toDecimal(task.commission),
          toDecimal(task.work_time),
          index + 1,
          asJson(task),
        ]);
      });

      asArray<WorkTag>(result.detail.tags).forEach((tag) => {
        const tagExternalId = toInt(tag.id);
        if (tagExternalId === null) return;

        workTagRows.push([
          workExternalId,
          tagMap.get(tagExternalId) ?? null,
          tagExternalId,
          cleanText(tag.code),
          cleanText(tag.name),
        ]);
      });

      asArray<WorkProduct>(result.detail.products).forEach((productLine, index) => {
        const productExternalId = toInt(productLine.product?.id);

        workProductRows.push([
          workExternalId,
          index + 1,
          productExternalId === null ? null : productMap.get(productExternalId) ?? null,
          productExternalId,
          cleanText(productLine.product?.code),
          cleanText(productLine.product?.name),
          cleanText(productLine.name),
          toDecimal(productLine.units),
          cleanText(productLine.teeth),
          toDecimal(productLine.price),
          toDecimal(productLine.discount),
          toDecimal(productLine.unit_price),
          toDecimal(productLine.total_price),
          toDecimal(productLine.vat),
          asJson(productLine),
        ]);
      });

      asArray<any>(result.detail.lots).forEach((lot, index) => {
        workLotRows.push([
          workExternalId,
          index + 1,
          toInt(lot?.id),
          asJson(lot),
        ]);
      });
    }

    await insertRows(
      conn,
      "external_work_tasks",
      [
        "task_external_id",
        "work_id",
        "work_external_id",
        "external_stage_id",
        "stage_external_id",
        "stage_name",
        "external_manufacturer_id",
        "manufacturer_external_id",
        "manufacturer_type",
        "manufacturer_name",
        "status",
        "status_name",
        "start_date",
        "finish_date",
        "estimated_delivery",
        "teeth_count",
        "cost",
        "commission",
        "work_time",
        "source_order",
        "raw_json",
      ],
      taskRows,
      1000
    );

    await insertRows(
      conn,
      "external_work_tags",
      ["work_external_id", "external_tag_id", "tag_external_id", "tag_code", "tag_name"],
      workTagRows,
      1000
    );

    await insertRows(
      conn,
      "external_work_products",
      [
        "work_external_id",
        "line_no",
        "external_product_id",
        "product_external_id",
        "product_code",
        "product_name",
        "name",
        "units",
        "teeth",
        "price",
        "discount",
        "unit_price",
        "total_price",
        "vat",
        "raw_json",
      ],
      workProductRows,
      1000
    );

    await insertRows(
      conn,
      "external_work_lots",
      ["work_external_id", "line_no", "lot_external_id", "raw_json"],
      workLotRows,
      1000
    );
  });
}

export type WorkDetailsRunOptions = {
  /** true = barrido: todas las ordenes de works (ignora WORK_DETAILS_ONLY_MISSING y WORK_DETAILS_LIMIT) */
  full?: boolean;
  /** que ordenes toma (default: missing si WORK_DETAILS_ONLY_MISSING=1, si no all) */
  filter?: RefsFilter;
  /** empezar despues de este work_id (para reanudar un barrido) */
  startAfterWorkId?: number;
  concurrency?: number;
  /** se revisa antes de cada lote; si devuelve true se detiene (completed=false) */
  shouldStop?: () => boolean;
  /** despues de guardar cada lote, con el ultimo work_id procesado */
  onBatchDone?: (lastWorkId: number) => void;
  label?: string;
};

export type WorkDetailsRunResult = {
  /** true = recorrio hasta que ya no hubo mas ordenes */
  completed: boolean;
  lastWorkId: number;
  attempted: number;
  persisted: number;
  failed: number;
};

export async function workDetailsEtl(opts: WorkDetailsRunOptions = {}): Promise<WorkDetailsRunResult> {
  const full = opts.full ?? false;
  const filter: RefsFilter = full
    ? "all"
    : opts.filter ?? (config.workDetails.onlyMissing ? "missing" : "all");
  const batchSize = Math.max(1, Math.trunc(config.workDetails.batchSize));
  const concurrency = Math.max(1, Math.trunc(opts.concurrency ?? config.workDetails.concurrency));
  const hardLimit = full ? 0 : Math.max(0, Math.trunc(config.workDetails.limit));
  const batchDelayMs = Math.max(0, Math.trunc(config.workDetails.batchDelayMs));
  const tag = opts.label ? ` [${opts.label}]` : "";

  let lastWorkId = Math.max(0, Math.trunc(opts.startAfterWorkId ?? config.workDetails.startAfterWorkId));
  let attempted = 0;
  let fetched = 0;
  let failed = 0;
  let persisted = 0;
  let worksDateUpdated = 0;

  let completed = false;
  const startedAt = Date.now();
  let apiMs = 0;
  let dbMs = 0;

  // [VELOCIDAD] Mientras un lote se guarda en la BD, ya se esta pidiendo el siguiente a la API.
  // El guardado corre en una promesa que no rechaza (devuelve el error) para no provocar un
  // "unhandled rejection"; el error se relanza al esperarla.
  let pendingSave: Promise<unknown> | null = null;
  const waitPendingSave = async () => {
    if (!pendingSave) return;
    const err = await pendingSave;
    pendingSave = null;
    if (err) throw err;
  };

  const saveBatch = async (validDetails: DetailResult[], batchLastWorkId: number) => {
    const t0 = Date.now();
    await persistDetails(validDetails);
    persisted += validDetails.length;
    worksDateUpdated += await syncWorksEstimatedDelivery(uniqueNumbers(validDetails.map(getWorkExternalId)));
    dbMs += Date.now() - t0;

    const minutes = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
    logger.info(
      `Work details ETL${tag}: progreso attempted=${attempted} fetched=${fetched} ` +
        `persisted=${persisted} failed=${failed} works_fecha_actualizada=${worksDateUpdated} ` +
        `lastWorkId=${batchLastWorkId} ritmo=${Math.round(persisted / minutes)}/min ` +
        `tiempo_api=${Math.round(apiMs / 1000)}s tiempo_bd=${Math.round(dbMs / 1000)}s`
    );

    opts.onBatchDone?.(batchLastWorkId);
  };

  logger.info(
    `Work details ETL${tag}: start ordenes=${filter} batchSize=${batchSize} concurrency=${concurrency} ` +
      `limit=${hardLimit || "ALL"} startAfterWorkId=${lastWorkId}`
  );

  try {
    while (!hardLimit || attempted < hardLimit) {
      if (opts.shouldStop?.()) break;

      const nextLimit = hardLimit ? Math.min(batchSize, hardLimit - attempted) : batchSize;
      const refs = await fetchNextWorkRefs(lastWorkId, nextLimit, filter);
      if (!refs.length) {
        completed = true;
        break;
      }

      lastWorkId = Math.max(...refs.map((ref) => Number(ref.work_id)));
      attempted += refs.length;

      logger.info(
        `Work details ETL: lote work_id>${refs[0].work_id - 1} refs=${refs.length} lastWorkId=${lastWorkId}`
      );

      const apiStart = Date.now();
      const details = await mapWithConcurrency(refs, concurrency, async (ref) => {
        try {
          const detail = await fetchWorkDetail(ref.external_id);
          if (!detail?.id) {
            logger.warn(`Work details ETL: detalle vacío external_id=${ref.external_id}`);
            failed += 1;
            return null;
          }

          fetched += 1;
          return { ref, detail };
        } catch (err: any) {
          failed += 1;
          logger.warn(
            `Work details ETL: no pude cargar detalle external_id=${ref.external_id} ` +
              `status=${err?.response?.status ?? err?.code ?? err?.message ?? "unknown"}`
          );
          return null;
        }
      });

      apiMs += Date.now() - apiStart;

      const validDetails = details.filter((item): item is DetailResult => item !== null);

      // el lote anterior tiene que quedar guardado antes de empezar a guardar este
      await waitPendingSave();
      pendingSave = saveBatch(validDetails, lastWorkId).then(
        () => null,
        (err) => err ?? new Error("Error guardando lote de detalles")
      );

      if (batchDelayMs) await sleep(batchDelayMs);
    }

    await waitPendingSave();
  } catch (err) {
    // terminar de guardar el lote en curso antes de salir con el error
    if (pendingSave) await pendingSave;
    throw err;
  }

  logger.info(
    `Work details ETL${tag}: ${completed ? "done" : "detenido"} attempted=${attempted} fetched=${fetched} ` +
      `persisted=${persisted} failed=${failed} works_fecha_actualizada=${worksDateUpdated} lastWorkId=${lastWorkId}`
  );

  return { completed, lastWorkId, attempted, persisted, failed };
}
