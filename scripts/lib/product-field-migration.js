import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sequelize } from '../../src/config/database.js';
import {
  productCoreFields,
  productExtensionFields,
} from '../../src/shared/product-field-manifest.js';
const raw = (sql, transaction, replacements = {}, type = 'SELECT') =>
  sequelize.query(sql, {
    transaction,
    ...(Object.keys(replacements).length ? { replacements } : {}),
    type,
    productStorage: false,
  });
export async function inspectProductFieldStorage(transaction) {
  const columns = await raw(
    "SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='products' ORDER BY ordinal_position",
    transaction,
  );
  const [state] = await raw(
    "SELECT to_regclass('public.product_records') IS NOT NULL AS migrated",
    transaction,
  );
  const extension = columns.filter((c) => !productCoreFields.includes(c.column_name));
  const conflicts = [];
  if (!state.migrated) {
    const names = extension.map((c) => c.column_name);
    const missing = productExtensionFields.filter((n) => !names.includes(n));
    const unknown = names.filter(
      (n) => !productExtensionFields.includes(n) && n !== 'is_configuration_group',
    );
    if (missing.length || unknown.length)
      conflicts.push({ reason: 'Unreviewed schema', missing, unknown });
    const [reserved] = await raw(
      "SELECT count(*)::int n FROM product_variants WHERE attributes ?| ARRAY['__product_fields','__product_store'] OR left(sku,length('__product_fields__:'))='__product_fields__:'",
      transaction,
    );
    if (reserved.n)
      conflicts.push({ reason: 'Reserved attribute/sku conflict', count: reserved.n });
  }

  if (!state.migrated) {
    const [rls] = await raw(
      "SELECT bool_or(relrowsecurity) AS enabled FROM pg_class WHERE oid IN ('public.products'::regclass,'public.product_variants'::regclass)",
      transaction,
    );
    if (rls.enabled) conflicts.push({ reason: 'Existing RLS needs review' });
    const custom = await raw(
      "SELECT tgname FROM pg_trigger WHERE tgrelid='public.products'::regclass AND NOT tgisinternal AND tgname NOT IN ('catalog_metadata','catalog_audit') ORDER BY tgname",
      transaction,
    );
    if (custom.length)
      conflicts.push({ reason: 'Unreviewed triggers', triggers: custom });
    const views = await raw(
      `SELECT DISTINCT c.relname FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class c ON c.oid=r.ev_class JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid WHERE d.refobjid='public.products'::regclass AND NOT a.attname=ANY(ARRAY['id','brand_id','name','slug','description','short_description','product_status','created_at','updated_at']) ORDER BY c.relname`,
      transaction,
    );
    if (views.length) conflicts.push({ reason: 'Dependent views require review', views });
  }
  const [version] = await raw(
    "SELECT current_setting('server_version_num')::int n",
    transaction,
  );
  if (version.n < 150000) conflicts.push({ reason: 'PostgreSQL 15+ required' });
  const snapshots = {};
  for (const table of [
    state.migrated ? 'product_records' : 'products',
    'product_variants',
    'inventory',
    'orders',
    'order_details',
    'audit_logs',
  ]) {
    const [r] = await raw(
      `SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) AS fingerprint FROM public.${table} t`,
      transaction,
    );
    snapshots[table] = r;
  }
  if (state.migrated) {
    const [r] = await raw(
      'SELECT count(*)::int n FROM product_variants WHERE attributes @> \'{"__product_store":true}\'',
      transaction,
    );
    if (columns.length !== 9 || r.n !== snapshots.product_records.count)
      conflicts.push({ reason: 'Incomplete migrated storage' });
  }
  const dependencies = await raw(
    "SELECT conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.products'::regclass OR confrelid='public.products'::regclass ORDER BY conname",
    transaction,
  );
  const indexes = await raw(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='products' ORDER BY indexname",
    transaction,
  );
  const variant_indexes = await raw(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='product_variants' ORDER BY indexname",
    transaction,
  );
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({ columns, snapshots, dependencies, indexes, variant_indexes }),
    )
    .digest('hex');
  return {
    migrated: state.migrated,
    physical_product_columns: columns.map((c) => c.column_name),
    fields_to_move: extension,
    variant_indexes,
    conflicts,
    can_apply: !conflicts.length,
    snapshots,
    fingerprint,
  };
}
export async function applyProductFieldStorage(expectedFingerprint) {
  return sequelize.transaction(async (transaction) => {
    await raw("SET LOCAL lock_timeout='10s'", transaction, {}, 'RAW');
    await raw('SELECT pg_advisory_xact_lock(771209)', transaction);
    await raw(
      'LOCK TABLE products,product_variants,inventory,orders,order_details,audit_logs IN ACCESS EXCLUSIVE MODE',
      transaction,
      {},
      'RAW',
    );
    const plan = await inspectProductFieldStorage(transaction);
    if (plan.migrated && plan.can_apply) return { already_applied: true };
    if (!expectedFingerprint || plan.fingerprint !== expectedFingerprint)
      throw Error('Missing/stale approved product-field migration fingerprint');
    if (!plan.can_apply)
      throw Error('Resolve product-field migration conflicts before applying');
    await raw(
      await readFile(
        new URL('../../sql/040-variant-backed-product-fields.sql', import.meta.url),
        'utf8',
      ),
      transaction,
      {},
      'RAW',
    );
    const after = await inspectProductFieldStorage(transaction);
    if (!after.migrated || !after.can_apply)
      throw Error('Product-field migration post-verification failed');
    return {
      migrated: true,
      physical_product_columns: after.physical_product_columns,
      fields_moved: plan.fields_to_move.length,
      products: after.snapshots.product_records.count,
    };
  });
}
export async function restoreProductFieldColumns(expectedFingerprint) {
  return sequelize.transaction(async (transaction) => {
    await raw("SET LOCAL lock_timeout='10s'", transaction, {}, 'RAW');
    await raw(
      'LOCK TABLE products,product_variants,inventory,orders,order_details,audit_logs IN ACCESS EXCLUSIVE MODE',
      transaction,
      {},
      'RAW',
    );
    const before = await inspectProductFieldStorage(transaction);
    if (!before.migrated) throw Error('Product field storage is not migrated');
    if (!expectedFingerprint || before.fingerprint !== expectedFingerprint)
      throw Error('Missing/stale reviewed rollback fingerprint');
    const [{ manifest }] = await raw(
      'SELECT product_field_storage_manifest() AS manifest',
      transaction,
    );
    const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
    for (const field of manifest.fields)
      await raw(
        `ALTER TABLE products ADD COLUMN ${quote(field.name)} ${field.type}`,
        transaction,
        {},
        'RAW',
      );
    await raw(
      'UPDATE public.products p SET ' +
        manifest.fields.map((f) => `${quote(f.name)}=v.${quote(f.name)}`).join(',') +
        ' FROM public.product_records v WHERE v.id=p.id',
      transaction,
      {},
      'RAW',
    );
    const hadGroup = manifest.fields.some((f) => f.name === 'is_configuration_group');
    const [{ mismatches }] = await raw(
      `SELECT count(*)::int AS mismatches FROM products p JOIN product_records v USING(id) WHERE to_jsonb(p) IS DISTINCT FROM ${hadGroup ? 'to_jsonb(v)' : "to_jsonb(v)-'is_configuration_group'"}`,
      transaction,
    );
    if (mismatches) throw Error('Rollback product field copy verification failed');
    for (const field of manifest.fields) {
      if (field.default !== null)
        await raw(
          `ALTER TABLE products ALTER COLUMN ${quote(field.name)} SET DEFAULT ${field.default}`,
          transaction,
          {},
          'RAW',
        );
      if (field.not_null)
        await raw(
          `ALTER TABLE products ALTER COLUMN ${quote(field.name)} SET NOT NULL`,
          transaction,
          {},
          'RAW',
        );
    }
    // Restore only absent constraints/indexes captured before migration; never CASCADE.
    for (const c of manifest.constraints) {
      const [{ present }] = await raw(
        "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.products'::regclass AND conname=:name) AS present",
        transaction,
        { name: c.name },
      );
      if (!present)
        await raw(
          `ALTER TABLE products ADD CONSTRAINT ${quote(c.name)} ${c.definition}`,
          transaction,
          {},
          'RAW',
        );
    }
    for (const definition of manifest.indexes) {
      const name = definition.match(/^CREATE (?:UNIQUE )?INDEX (\S+) ON /)?.[1];
      if (!name) throw Error('Unknown saved index definition');
      const [{ present }] = await raw(
        'SELECT to_regclass(:name) IS NOT NULL AS present',
        transaction,
        { name },
      );
      if (!present) await raw(definition, transaction, {}, 'RAW');
    }
    await raw(
      'DROP VIEW product_records; DROP VIEW product_variant_records;',
      transaction,
      {},
      'RAW',
    );
    await raw(
      'DROP TRIGGER create_product_field_store ON products; DROP TRIGGER protect_product_field_store ON product_variants; DROP TRIGGER protect_product_field_actor ON users;',
      transaction,
      {},
      'RAW',
    );
    await raw(
      'DELETE FROM product_variants WHERE attributes @> \'{"__product_store":true}\'',
      transaction,
      {},
      'RAW',
    );
    await raw(
      'DROP INDEX IF EXISTS variant_configuration_attributes_unique',
      transaction,
      {},
      'RAW',
    );
    // Recently deleted internal JSON tuples can still be visited during an index build.
    // Keep the identical uniqueness rule for all real variants without indexing retired metadata.
    for (const c of manifest.variant_combinations)
      await raw(
        `CREATE UNIQUE INDEX ${quote(c.name)} ON product_variants(product_id,attributes) WHERE NOT attributes @> '{"__product_store":true}'`,
        transaction,
        {},
        'RAW',
      );
    for (const i of manifest.variant_indexes)
      await raw(
        `CREATE UNIQUE INDEX ${quote(i.name)} ON product_variants(product_id,attributes) WHERE NOT attributes @> '{"__product_store":true}'`,
        transaction,
        {},
        'RAW',
      );
    for (const trigger of manifest.triggers) await raw(trigger, transaction, {}, 'RAW');
    for (const index of [
      'product_field_store_owner',
      'product_field_sku_unique',
      'product_field_code_unique',
      'product_field_creator_idx',
      'product_field_updater_idx',
    ])
      await raw('DROP INDEX ' + quote(index), transaction, {}, 'RAW');
    await raw(
      'DROP FUNCTION write_product_record(); DROP FUNCTION create_product_field_store(); DROP FUNCTION protect_product_field_store(); DROP FUNCTION protect_product_field_actor(); DROP FUNCTION product_field_defaults(); DROP FUNCTION product_field_storage_manifest();',
      transaction,
      {},
      'RAW',
    );
    return {
      restored: true,
      columns_restored: manifest.fields.length,
      orders_unchanged: true,
      real_variants_retained: true,
    };
  });
}
