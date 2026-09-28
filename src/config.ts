import dotenv from "dotenv";
dotenv.config();

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function toBool(v: any, def = false) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

// Acepta DB_PASS o DB_PASSWORD y permite contraseña vacía (MySQL local sin password).
function dbPassword(): string {
  const v = process.env.DB_PASS ?? process.env.DB_PASSWORD;
  if (v === undefined) throw new Error("Missing env var: DB_PASS (o DB_PASSWORD)");
  return v;
}

function toNum(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function toHour(v: any, def: number) {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 && n <= 23 ? n : def;
}

// [SPLIT] Este repo siempre corre en modo DETAILS_ONLY (detalle / mantenimiento de works),
// por eso ya no necesita ETL_MODE.

export const config = {
  api: {
    baseUrl: must("API_BASE_URL"),
    token: must("API_TOKEN"),
    authHeader: process.env.API_AUTH_HEADER ?? "Authorization",
    authPrefix: process.env.API_AUTH_PREFIX ?? "Bearer",
  },
  db: {
    host: must("DB_HOST"),
    user: must("DB_USER"),
    password: dbPassword(),
    database: must("DB_NAME"),
    port: Number(process.env.DB_PORT ?? "3306"),
    // [RAM] limites del pool (ver src/db.ts)
    poolLimit: Math.max(1, toNum(process.env.DB_POOL_LIMIT, 5)),
    poolMaxIdle: Math.max(0, toNum(process.env.DB_POOL_MAX_IDLE, 2)),
    maxPreparedStatements: Math.max(1, toNum(process.env.DB_MAX_PREPARED_STATEMENTS, 50)),
  },
  tz: process.env.TZ ?? "America/Guatemala",
  cronExpr: process.env.CRON_EXPR ?? "*/3 * * * *",

  etl: {
    mode: "DETAILS_ONLY" as const,
    runOnce: toBool(process.env.ETL_RUN_ONCE, false),
  },

  workDetails: {
    batchSize: toNum(process.env.WORK_DETAILS_BATCH_SIZE, 100),
    concurrency: toNum(process.env.WORK_DETAILS_CONCURRENCY, 2),
    limit: toNum(process.env.WORK_DETAILS_LIMIT, 0),
    startAfterWorkId: toNum(process.env.WORK_DETAILS_START_AFTER_WORK_ID, 0),
    onlyMissing: toBool(process.env.WORK_DETAILS_ONLY_MISSING, false),
    // Con ONLY_MISSING=1, ademas vuelve a pedir el detalle de las ordenes cuyo status o finish_date
    // en works (lo actualiza el ETL del listado) ya no coincide con el detalle guardado.
    refreshChanged: toBool(process.env.WORK_DETAILS_REFRESH_CHANGED, true),
    // No vuelve a pedir la misma orden si su detalle se guardo hace menos de estos minutos.
    refreshMinAgeMinutes: Math.max(0, toNum(process.env.WORK_DETAILS_REFRESH_MIN_AGE_MINUTES, 15)),
    // Tambien vuelve a pedir: terminadas en los ultimos N dias sin fecha de envio (delivery_note_date) y
    // creadas en los ultimos N dias sin ninguna fecha estimada. 0 = no.
    refreshMissingDatesDays: Math.max(0, toNum(process.env.WORK_DETAILS_REFRESH_MISSING_DATES_DAYS, 7)),
    // Al guardar el detalle, copia la fecha de envio a works.estimated_delivery.
    syncWorksEstimatedDelivery: toBool(process.env.WORK_DETAILS_SYNC_WORKS_ESTIMATED_DELIVERY, true),
    batchDelayMs: toNum(process.env.WORK_DETAILS_BATCH_DELAY_MS, 250),
    // Barrido diario: una sola vez al dia, a partir de WORK_DETAILS_NIGHTLY_START_HOUR (hora de
    // Guatemala, default 19), recorre TODAS las ordenes (como ONLY_MISSING=0) hasta terminar, sin
    // hora de fin. El resto del tiempo corre lo normal (pendientes + cambios de estado).
    nightly: {
      enabled: toBool(process.env.WORK_DETAILS_NIGHTLY_FULL, true),
      startHour: toHour(process.env.WORK_DETAILS_NIGHTLY_START_HOUR, 19),
      concurrency: toNum(
        process.env.WORK_DETAILS_NIGHTLY_CONCURRENCY,
        toNum(process.env.WORK_DETAILS_CONCURRENCY, 2)
      ),
    },
  },
};
