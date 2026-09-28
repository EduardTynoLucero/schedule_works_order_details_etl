# schedule_works_order_details_etl

ETL 3 de 3. **Detalle / mantenimiento de ordenes de trabajo**: recorre `works` y trae `/works/{id}` para llenar
`external_work_details`, `external_work_tasks`, `external_work_tags`, `external_work_products`, `external_work_lots`
y los catalogos `external_stages`, `external_manufacturers`, `external_tags`, `external_products`.

Es el antiguo `ETL_MODE=DETAILS_ONLY` de `schedule_works_order_etl`. La logica de `workDetailsEtl` es la misma, sin cambios.
Depende de que `schedule_works_order_list_etl` haya llenado `works`.

## Uso

```bash
npm install
cp .env.example .env   # completar credenciales
npm run build
npm start
```

## RAM y pool de conexiones (`src/db.ts`)

- El SQL que cambia de tamaño en cada lote (INSERT de N filas, `IN (...)` de N valores) va por `query`
  (`execQuery` / `conn.query`), no por `execute`. Con `execute`, mysql2 guardaba un prepared statement por cada
  tamaño distinto (hasta 16000 por conexion) y MySQL los mantenia abiertos: eso era lo que subia la RAM.
- El pool esta acotado: `DB_POOL_LIMIT` (5), `DB_POOL_MAX_IDLE` (2, las demas se cierran a los 60s) y
  `DB_MAX_PREPARED_STATEMENTS` (50).
- Con `ETL_RUN_ONCE=1` el pool se cierra al terminar, asi el proceso sale solo. Con SIGINT/SIGTERM tambien se cierra.

## Que ordenes procesa cada vuelta (7:00 a 22:00)

Con `WORK_DETAILS_ONLY_MISSING=1`, cada vuelta hace dos pasadas:
1. **Por actualizar** (con `WORK_DETAILS_REFRESH_CHANGED=1`): ordenes con detalle cuyo `status` o `finish_date`
   cambio en `works`; terminadas en los ultimos `WORK_DETAILS_REFRESH_MISSING_DATES_DAYS` (7) dias sin
   `delivery_note_date`; y creadas en esos dias sin ninguna fecha estimada. Una misma orden no se vuelve a
   pedir antes de `WORK_DETAILS_REFRESH_MIN_AGE_MINUTES` (15).
2. **Sin detalle**: ordenes nuevas que todavia no tienen fila en `external_work_details`.

Con `WORK_DETAILS_ONLY_MISSING=0` procesa todas las ordenes en cada vuelta.

## estimated_delivery

En `external_work_details.estimated_delivery` se guarda `delivery_note_date` (fecha de envio, a las 00:00:00).
Si la orden todavia no tiene `delivery_note_date`, se guarda el `estimated_delivery` de la API.
`delivery_note_date` tambien se sigue guardando en su propia columna.

Despues de guardar cada lote, copia la fecha a `works.estimated_delivery`
(`WORK_DETAILS_SYNC_WORKS_ESTIMATED_DELIVERY=1`): fecha de envio si existe; si no, se conserva la de `works`;
si `works` no tiene, la estimada del detalle.

## Barrido diario (una sola vez al dia)

- Todos los dias, a partir de `WORK_DETAILS_NIGHTLY_START_HOUR` (default 19:00, hora de Guatemala), hace
  **una sola vez** un barrido de todas las ordenes con `WORK_DETAILS_NIGHTLY_CONCURRENCY` consultas simultaneas.
- No tiene hora de fin: corre hasta terminar, aunque pase de las 22:00 o de la medianoche.
- El resto del tiempo, entre 7:00 y 22:00, cada vuelta procesa solo pendientes y ordenes que cambiaron de estado.
- Si el barrido se corta por un error, la siguiente vuelta lo retoma desde el ultimo `work_id` guardado.
- Se apaga con `WORK_DETAILS_NIGHTLY_FULL=0`. Necesita `ETL_RUN_ONCE=0` (proceso siempre vivo).
- El estado se guarda en memoria: si el proceso se reinicia, el barrido vuelve a correr completo.

## Velocidad

- Mientras un lote se guarda en la BD, ya se esta pidiendo el siguiente a la API (se solapan).
- Las conexiones HTTPS a la API se reutilizan (keep-alive); en Node 18 no venia activado.
- El log de progreso muestra `ritmo=N/min`, `tiempo_api` y `tiempo_bd` acumulados:
  - si `tiempo_api` es mucho mayor que `tiempo_bd`, sube `WORK_DETAILS_CONCURRENCY` / `WORK_DETAILS_NIGHTLY_CONCURRENCY`;
  - si aparecen `HTTP retry ... status=429`, la API esta frenando: bajalo.
  - si `tiempo_bd` domina, sube `WORK_DETAILS_BATCH_SIZE` (por ejemplo 200).
