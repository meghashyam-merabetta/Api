import { sequelize } from '../config/database.js';
import { tableFields } from './fields.js';
export async function assertTeamSchemaReady() {
  const rows = await sequelize.query(
    "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('products','product_details','warehouses','product_inventory')",
    { type: 'SELECT', productStorage: false },
  );
  const actual = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = Object.entries(tableFields).flatMap(([table, fields]) =>
    Object.keys(fields)
      .filter((f) => !actual.has(`${table}.${f}`))
      .map((f) => `${table}.${f}`),
  );
  if (missing.length)
    throw Error(
      `Team catalog schema is incomplete: ${missing.join(', ')}. Apply only the approved prerequisite migration.`,
    );
}
