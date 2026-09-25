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
