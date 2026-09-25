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

function toNum(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
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
    password: must("DB_PASS"),
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
    batchDelayMs: toNum(process.env.WORK_DETAILS_BATCH_DELAY_MS, 250),
  },
};
