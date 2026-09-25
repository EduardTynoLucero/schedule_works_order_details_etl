import { config } from "./config.js";
import { closePool } from "./db.js";
import { logger } from "./etl/common/logger.js";
import { inExecutionWindow } from "./etl/common/time.js";
import { workDetailsEtl } from "./etl/workDetailsEtl.js";

// [SPLIT] ETL 3/3: detalle / mantenimiento de ordenes de trabajo (antes ETL_MODE=DETAILS_ONLY).
// Recorre la tabla works (que llena schedule_works_order_list_etl) y trae /works/{id}.

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let running = false;

async function runOnce() {
  if (running) {
    logger.warn("ETL ya está corriendo. Skip.");
    return;
  }
  running = true;

  try {
    if (!inExecutionWindow(config.tz)) {
      logger.info("Fuera de ventana (7AM-10PM Guatemala).");
      return;
    }

    logger.info(`ETL work details run. mode=${config.etl.mode}`);

    await workDetailsEtl();

    logger.info("ETL OK");
  } catch (err: any) {
    logger.error("ETL ERROR", err?.stack ?? err?.message ?? err);
  } finally {
    running = false;
  }
}

async function mainLoop() {
  logger.info(`Loop iniciado (work details). tz=${config.tz}. Ejecuta al terminar + espera 1 minuto.`);
  while (true) {
    await runOnce();
    await sleep(60_000);
  }
}

// [RAM] Cierre ordenado: libera las conexiones del pool al detener el proceso (pm2, docker, Ctrl+C).
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.warn(`${signal} recibido. Cerrando pool de BD...`);
  await closePool();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

if (config.etl.runOnce) {
  // [RAM] Al terminar se cierra el pool; si no, las conexiones quedan abiertas y el proceso
  // nunca termina (si un programador de tareas lo lanza cada X minutos, se acumulan procesos).
  runOnce()
    .catch((e) => logger.error("FATAL", e))
    .finally(() => closePool());
} else {
  mainLoop().catch((e) => logger.error("FATAL", e));
}
