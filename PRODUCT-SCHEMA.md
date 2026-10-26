# Product schema implementation

The schema supplied in the correction request is the core contract. Earlier pricing, inventory, specification and discount columns are retained, as requested.

| Table | Implementation |
| --- | --- |
| `products` | Existing model maps `product_id` to `id` and `product_name` to `name`; all listed columns and earlier extensions are retained. |
| `product_variants` | Model and CRUD now include `variant_name`, `barcode`, `weight_grams`, JSONB attributes and earlier price/stock extensions. |
| `product_images` | Existing image CRUD maps the listed columns, including `s3_key`; image writes refresh published catalog image metadata. |
| `product_categories` | Existing join model retains the composite key and `is_primary`. |
| `product_catalog` | Timestamp-free model with VARCHAR(100) ID, JSONB data, and active flag; used by customer product reads, saved items and checkout pricing. |
| `product_order_counters` | Timestamp-free model keyed by `order_day`; atomic daily number allocation. |
| `product_checkouts` | Model includes every listed field. New checkout, lookup, list, status sync and webhook handling use this table. |

## Migration and deployment

`sql/026-product-schema-alignment.sql` adds missing variant fields and creates checkout/counter tables when absent. It copies historical `orders` into `product_checkouts` while preserving IDs, customer ownership, payment data and payload snapshots. It leaves `orders` and `order_details` in place. Conflicting history IDs or request keys cause migration failure rather than overwriting checkout data. Reruns skip history already copied and preserve the highest daily counter.

Stop API instances that still write to `orders`, run `npm run db:migrate`, then start the updated backend. The new migration was tested in a disposable PostgreSQL database; it has not been applied to the configured live database during this change. Migrations do not run on application startup.

Old `order_details` remain historical records. New line items and their immutable product snapshots are saved in `product_checkouts.payload.items`; no parallel legacy `orders` row is created for new checkouts. Account-linking checks now look for checkout activity in `product_checkouts`.

## Variant API

Existing list/create/update/delete routes remain. Individual variants can also be fetched with `GET /api/admin/products/:productId/variants/:variantId`. New optional fields:

```json
{
  "sku": "JOY-M",
  "variant_name": "Medium pack",
  "attributes": { "Size": "M" },
  "barcode": "0123456789012",
  "weight_grams": 250,
  "stock_quantity": 25,
  "regular_price": 999,
  "sale_price": 799,
  "is_active": true
}
```

`weight_grams` is a nonnegative integer. Barcode remains a string so leading zeros survive. All three new fields can be cleared with null. `display_name` prefers `variant_name`, falling back to separate attribute values. Duplicate complete attribute combinations within a product return 409.

## Customer catalog

`GET /api/app/products` now reads active `product_catalog` rows instead of the keyboard/mouse demo array. It accepts `limit`, `offset`, `search` (name), and `category_id`. Responses contain `data` and `pagination`. `GET /api/app/products/:id` returns one active catalog entry or 404.

Admin product, variant, category-assignment and image changes publish snapshots transactionally. Active simple products with prices use catalog IDs `product:<product-id>`. Active variants of active variable products use `variant:<variant-id>`. Each variant has its own name, barcode, attributes, weight, stock and price, with parent pricing as the fallback. Draft, inactive, deleted or unpriced entries are inactive in the catalog. Existing seeded IDs such as `p1` remain valid. An already-existing admin product is published when it is next saved; this change does not bulk-publish existing products automatically.

Catalog snapshots include numeric `price` and `mrp`, primary image, ordered image metadata and category IDs. Prices include enabled special/festival discounts as documented in `ADMIN-CATALOG-API.md`. Checkout reads database prices, never client amounts. Cart and wishlist continue accepting the stable catalog IDs.

## Checkout and stock

The public routes remain `POST/GET /api/app/orders` and `GET /api/app/orders/:id`; only persistence changes to `product_checkouts`. The gateway-facing ID remains the existing 20-character `MB` plus 18 hex digits. A separate customer-facing `orderNumber` uses `MBYYMMDDnnnnn`, for example `MB26102600001`, fitting VARCHAR(13). The day is computed in Asia/Kolkata. Allocation uses an atomic upsert, never reuses an allocated number, and returns 503 after 99,999 orders in a day.

Checkout reserves managed product/variant stock in the same transaction as prices, snapshots, the counter and the saved checkout. Parent products and catalog rows are locked in a consistent order. Competing orders cannot reserve the same last units. Quantity limits are enforced. A failed validation rolls back stock and counter changes. Matching checkout retries reuse the saved checkout and reserve no additional stock.

`stock_state` values:

- `legacy`: migrated history, with no retroactive stock adjustment.
- `unmanaged`: catalog entries without inventory quantities, preserving seeded catalog behavior.
- `reserved`: inventory deducted for an unpaid checkout.
- `committed`: reserved inventory belongs to a verified charged checkout.

Mixed carts use `reserved` when any item has managed inventory. Verified payment sync records `payment_checked_at` and commits the stock state without deducting it again. Paid checkouts cannot regress on delayed failure notifications. Uncertain and failed payments retain reserved stock: automatic release/cancellation is not implemented, to avoid releasing stock before a later charge is resolved. Such reservations require operational reconciliation.

Responses include `orderNumber`, `stockState` and `paymentExpiry`. Stored expired payment links are not returned. `payment_expiry` remains nullable; no provider expiry is invented. Existing merchant, currency, order and amount verification remains in place.

## Verification

- `npm run check`, `npm run lint`.
- Existing catalog/image regression integration suite in its disposable database.
- `scripts/product-schema-db.test.js` verifies repeatable migration, conflict detection, variant fields, catalog filtering, stock concurrency, idempotency, immutable snapshots, customer ownership, payment timestamps, paid-state protection, quantity rollback, expired links and counter exhaustion. Gateway requests are mocked; no real payments are sent.

To run the schema suite, provision a disposable PostgreSQL database whose name starts with `codex_catalog_schema_test`, set explicit `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL=false`, and `NODE_ENV=test`, then run:

```sh
RUN_PRODUCT_SCHEMA_DB_TESTS=true node --import ./test-support/env.js --test scripts/product-schema-db.test.js
```

This opt-in suite resets product, catalog and checkout fixtures in that disposable database.
