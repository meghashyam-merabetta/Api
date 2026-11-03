import { env } from '../config/env.js';
import { sequelize } from '../config/database.js';
export async function assertProductFieldStorageReady() {
  const [row] = await sequelize.query(
    `SELECT to_regclass('public.product_records') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.product_records') AND tgname='write_product_record' AND tgenabled IN ('O','A')) AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.product_variants') AND tgname='protect_product_field_store' AND tgenabled IN ('O','A')) AS ready,
 (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='products')=9 AS core_only`,
    { type: 'SELECT', productStorage: false },
  );
  if (!env.VARIANT_PRODUCT_FIELDS_ENABLED) {
    if (row.ready && row.core_only)
      throw Error(
        'Variant-backed storage is already installed; enable VARIANT_PRODUCT_FIELDS_ENABLED before serving this database',
      );
    return;
  }
  if (!row.ready || !row.core_only)
    throw Error(
      'Variant-backed product storage requires separately approved migration 040; do not serve against an incomplete schema',
    );
}
