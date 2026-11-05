import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { env } from '../config/env.js';

export async function assertIndependentCatalogReady() {
  if (!env.INDEPENDENT_PRODUCTS_ENABLED) return;
  const [row] = await sequelize.query(
    `SELECT count(*) AS count FROM products p WHERE p.product_status='active'
    AND NOT p.inventory_managed AND COALESCE(to_jsonb(p)->>'deleted_at','')=''`,
    { type: QueryTypes.SELECT },
  );
  if (Number(row.count))
    throw new Error(
      'Independent-product cutover is incomplete: active legacy products remain. Keep INDEPENDENT_PRODUCTS_ENABLED=false until approved conversion is complete.',
    );
}
