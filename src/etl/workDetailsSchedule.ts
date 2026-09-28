import { config } from "../config.js";
import { logger } from "./common/logger.js";
import { currentHour, inExecutionWindow, todayKey } from "./common/time.js";
import { logPendingRefs, workDetailsEtl } from "./workDetailsEtl.js";

// Que corre en cada vuelta del ETL de detalle:
// - Barrido diario: UNA sola vez al dia, a partir de WORK_DETAILS_NIGHTLY_START_HOUR (default 19:00,
//   hora de Guatemala), recorre TODAS las ordenes hasta terminar. No tiene hora de fin: si pasa de la
//   medianoche o de las 22:00, sigue hasta acabar.
// - El resto del tiempo, dentro de la ventana de 7 a 22: primero las ordenes que cambiaron de estado o
//   les falta fecha, despues las nuevas sin detalle.
//
// El estado del barrido se guarda en memoria: si el proceso se reinicia, se pierde el avance y el
// barrido vuelve a correr completo ese mismo dia (si ya son mas de las 19:00) o al dia siguiente.

let sweepDoneDay: string | null = null; // dia en que ya se completo el barrido
let sweepPendingDay: string | null = null; // barrido empezado y no terminado (por un error)
let sweepCursor = 0; // ultimo work_id guardado por el barrido en curso

async function runSweep(day: string) {
  const n = config.workDetails.nightly;

  logger.info(
    `Barrido diario (${day}): todas las ordenes desde work_id>${sweepCursor}, sin hora de fin, ` +
      `concurrency=${n.concurrency}`
  );

  sweepPendingDay = day;
  const res = await workDetailsEtl({
    full: true,
    startAfterWorkId: sweepCursor,
    concurrency: n.concurrency,
    onBatchDone: (lastWorkId) => {
      sweepCursor = lastWorkId;
    },
    label: "barrido diario",
  });

  if (res.completed) {
    sweepDoneDay = day;
    sweepPendingDay = null;
    sweepCursor = 0;
    logger.info(`Barrido diario (${day}) completo. El siguiente es manana desde las ${n.startHour}:00.`);
  }
}

/** Corre lo que toca en esta vuelta. Devuelve true si proceso algo. */
export async function runWorkDetailsCycle(): Promise<boolean> {
  const n = config.workDetails.nightly;

  // 1) un barrido que se corto por un error se retoma donde quedo, sin importar la hora
  if (n.enabled && sweepPendingDay) {
    await runSweep(sweepPendingDay);
    return true;
  }

  // 2) barrido del dia: desde la hora de inicio, si hoy todavia no se hizo
  const today = todayKey(config.tz);
  if (n.enabled && currentHour(config.tz) >= n.startHour && sweepDoneDay !== today) {
    sweepCursor = 0;
    await runSweep(today);
    return true;
  }

  // 3) lo normal, dentro de la ventana de 7 a 22
  if (!inExecutionWindow(config.tz)) {
    logger.info("Fuera de ventana (7AM-10PM Guatemala).");
    return false;
  }

  logger.info(`ETL work details run. mode=${config.etl.mode}`);
  const wd = config.workDetails;

  if (!wd.onlyMissing) {
    await workDetailsEtl({ filter: "all" });
    return true;
  }

  await logPendingRefs();
  // 1) primero las que cambiaron de estado o les falta fecha (lo que importa ver al dia)
  if (wd.refreshChanged) await workDetailsEtl({ filter: "stale", label: "por actualizar" });
  // 2) despues las ordenes nuevas sin detalle
  await workDetailsEtl({ filter: "missing", label: "sin detalle" });
  return true;
}
