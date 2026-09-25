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
