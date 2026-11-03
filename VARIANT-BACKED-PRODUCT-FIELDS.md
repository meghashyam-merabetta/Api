# Nine-column products with variant-backed extension fields

Implementation on `feat/variant-backed-product-fields-20261103`. Backend commit `7f7485d` and migration 040 were deployed to user-confirmed UAT on 3 November 2026 under separate application/migration approvals. This design supersedes the standalone rollout in PR #29. Configuration migration 039 and product conversion remain disabled.

## Physical storage and compatibility

The physical `public.products` table retains exactly these original columns, with their IDs, core values, defaults and core foreign keys preserved:

`id`, `brand_id`, `name`, `slug`, `description`, `short_description`, `product_status`, `created_at`, `updated_at`.

All original 91 additional columns move into JSONB at `product_variants.attributes.__product_fields`. JSON numbers, booleans, nulls, arrays, objects, dates and UUID metadata are preserved; they are not stringified. Existing Size/Colour dictionaries remain untouched.

There is **one reserved, inactive storage row per product**, including simple and archived products that otherwise have no variants. It has `attributes.__product_store=true` and SKU `__product_fields__:<productId>`. These are bookkeeping records, not configurations for sale. A single copy avoids repeating all 91 fields across every size. Storage rows are excluded from the ORM, list totals, variant definitions, galleries and checkout through the filtered `product_variant_records` view. Existing real variant IDs/SKUs/attributes/prices remain intact. Reserved JSON keys and SKU prefixes cannot be created through normal variant APIs.

Example storage JSON (abbreviated):

```json
{
  "__product_store": true,
  "__product_fields": {
    "sku": "BP-2000",
    "regular_price": 1000.00,
    "stock_quantity": 30,
    "reusable": false,
    "keywords": ["BP monitor"],
    "deleted_at": null,
    "created_by": null,
    "attributes": {"Capacity": "2000mAh"}
  }
}
```

`product_records` is a typed compatibility view over the original nine-column table and its JSON storage row. The ORM and application SQL use these views only when `VARIANT_PRODUCT_FIELDS_ENABLED=true`; PostgreSQL remains the same database and no managed service is added. JSON expression indexes preserve product SKU/code uniqueness and actor lookups. Real-variant attribute uniqueness excludes internal storage rows, preventing large metadata from overflowing the old whole-attributes btree. Storage identity and metadata are guarded against direct normal API writes. Product writes preserve actor provenance and append product audits. Soft deletion moves to typed JSON-backed `deleted_at`, retaining stock/orders/images/history.

The current UI keeps its flat product requests/responses, existing variant selection objects, routes, save sequence and gallery behavior. The 91 fields are physically relocated; this does not by itself make the API list response smaller. A compact response DTO is a separate change. PostgreSQL operators can use `product_records` for the previous flat query shape.

The distinct-product-ID implementation is retained: S/M/L each get separate real product IDs and inventory ownership when the configuration feature is separately enabled. Its UI grouping is compatibility metadata rather than shared stock. Modified schema 039 uses the virtual group flag when the new storage view exists; it does not re-add a products column. Do not deploy the older standalone 039 file from PR #29 after this change.

## Migration 040 and preflight

Migration `sql/040-variant-backed-product-fields.sql` copies every retained product (including archived rows), verifies the complete typed old/new record equality and counts, and only then drops the extension columns. No `CASCADE` is used. Core products/variant IDs, real variant data and historical orders are not rewritten. Field/index/constraint/trigger definitions are recorded in a PostgreSQL metadata function for recovery, not a new product-data table.

Preflight rejects missing/unknown columns, reserved-key conflicts, unreviewed triggers, RLS, dependent views and unsupported PostgreSQL versions. The SQL also rejects foreign keys targeting extension columns. Any copy verification, dependency or uniqueness error rolls back the entire transaction. PostgreSQL 15+ is required for security-invoker views.

Read-only preview:

```bash
node scripts/migrate-product-fields.js
```

It writes local `PRODUCT-FIELD-STORAGE-PREVIEW.json` with metadata, counts, hashes, conflicts and a fingerprint; no product values, credentials or auth cookies are printed. `npm run products:fields:preview` is a local alias. Preserve UAT's existing package manifests; run the node command there.

Applying requires **separate approval**, a freshly reviewed fingerprint and a restricted, verified custom-format database backup. The CLI requires the backup file, SHA-256 and a successful full `pg_restore --file /dev/null` read verification. It never silently runs schema migration during application startup.

```bash
node scripts/migrate-product-fields.js --apply \
  --fingerprint='<fresh reviewed fingerprint>' \
  --backup-file='/restricted/path/appdb-before.dump' \
  --backup-sha256='<verified SHA-256>'
```

`PRODUCT_PG_RESTORE_BIN` can select the installed PostgreSQL client executable. The original bootstrap migrator refuses to run after cutover, preventing it from recreating the dropped columns. Do not manually rerun older product-schema migrations against the new layout.

Read-only UAT preflight on 3 November 2026 confirmed 100 existing columns, the expected 91 extensions, no reported conflicts, 150 products, 176 real variants, 131 inventory rows and 14 orders. These are a snapshot; refresh after backup/maintenance begins. That preflight was read-only; the subsequently approved deployment is recorded below.

## Coordinated rollout and recovery

1. Review/preserve current server modifications, freeze the exact rsync allowlist and dry run, and take verified restricted application/database backups. Do not overwrite .env, manifests, dependencies, keys or unrelated files.
2. Obtain approval for application/runtime changes and separately for migration 040. Stop only the confirmed API service for the cutover: the old backend cannot run against removed physical columns. Apply the fingerprint-guarded migration, deploy the reviewed backend via rsync, set `VARIANT_PRODUCT_FIELDS_ENABLED=true` in the approved runtime and reload only root PM2 `server` ID 0. No new dependency installation is needed.
3. Keep configuration activation/conversion separate: if approved, use the revised 039, enable `CONFIGURATION_PRODUCTS_ENABLED`, and convert only the reviewed group(s). JOYLIFE 998974 has the user-confirmed policy of 30 each for M/L/XL (90 total); other legacy stock/availability conflicts remain unresolved. This storage migration itself does not authorize or perform configuration conversion.
4. Verify physical columns, complete carrier coverage, real-variant counts, authenticated product CRUD, sorting/filtering, categories/deletion previews, pricing, galleries, inventory/checkout and append-only history. Positive business-write probes require an approved test scope; read-only checks must not be described as live CRUD verification.

The local inverse migration copies the current JSON values back to their captured typed columns, verifies equality, restores original defaults/product constraints/indexes/triggers, and removes only internal storage rows. It retains equivalent unique partial indexes for real variant combinations so retired large metadata tuple versions cannot overflow a whole-JSON index during atomic rollback. It does not change real variant data, orders, stock or audit history. This index representation differs from the original UNIQUE constraint object; application code does not use that constraint by name or ON CONFLICT inference.

Before any new configuration IDs/orders exist, a separately approved rollback during an API pause can run `scripts/migrate-product-fields.js --restore` with the current reviewed fingerprint and verified backup arguments, then restore compatible application/runtime settings. Tests verify data recovery including large metadata. If new configuration identities or orders have been created, retain compatible readers and prepare a reviewed compensating recovery; do not blindly restore a whole database or disable identity support. Original backups remain necessary even though the inverse is tested.

No AWS resources are created by this implementation. JSONB, compatibility views and migration activity still use existing database storage/CPU; schema movement alone is not a measured cost saving. No table rewrite/VACUUM FULL or cloud resizing is performed automatically.

## pgAdmin reads after approved migration

```sql
-- Original physical product fields only.
SELECT * FROM public.products ORDER BY id;

-- Typed compatibility reads, including all relocated fields.
SELECT id, name, sku, regular_price, deleted_at
FROM public.product_records
WHERE product_status='active' AND deleted_at IS NULL;

-- Actual JSON backing for a product. Storage rows are intentionally inactive.
SELECT product_id, attributes->'__product_fields' AS product_fields
FROM public.product_variants
WHERE attributes @> '{"__product_store":true}';

-- Real variants only, excluding internal bookkeeping.
SELECT * FROM public.product_variant_records;
```

Existing inventory remains authoritative for independently managed products. Never treat hidden storage rows or legacy parent stock as additional sellable inventory.

Deployment correction: UAT has no attribute-combination UNIQUE constraint and contains archived duplicate combinations. Migration 040 preserves that existing rule instead of introducing a new one; an archived-duplicate regression fixture covers migration and rollback. Existing database check constraints are replayed without adding new price/stock restrictions; API validation is retained.

## UAT deployment record — 3 November 2026

Release `merabetta-variant-fields-20261103-r2` deployed 28 allowlisted backend files and migration 040 via rsync/SSH, with a verified restricted application/database backup and a pause/reload of only root PM2 server ID 0. All 150 original product records and 176 real variants were verified unchanged before reopening. All 17 baseline business tables were subsequently reconciled against the backup with no missing/modified original rows, except the expected payment polling timestamp. Authenticated admin activity after reopening added a product/variant and images; those records were preserved. `.env`, manifests, dependencies and unrelated source remain unchanged. No migration 039, configuration conversion, extra AWS service or dependency installation was included.

Twenty-six initial API/CMS read checks matched baseline values (two association serialization-order differences were proven harmless); a later 26-request availability run also passed expected statuses. Existing inventory/audit-history URLs for product 998974 still return their pre-deployment 404s. Live write probes were not performed. The detailed deployment evidence is in the original workspace under `deployment-review/variant-backed-fields-2026-11-03/REVIEW.md`.

The first attempted migration rolled back safely on archived duplicate variant combinations because it added an unintended uniqueness rule. The corrected migration preserves only existing uniqueness rules; original unique-layout and archived-duplicate fixtures each passed eight tests. It then deployed successfully. Backups remain in the private remote release directory. Never restore the full old database over newer writes; use reviewed inverse migration and source/runtime rollback with fresh guards.
