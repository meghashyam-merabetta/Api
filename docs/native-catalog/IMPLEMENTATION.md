# Native schema continuation — 5 November 2026

Built on the user's latest local product model, model associations, product controller/validator/routes, inventory routes, and warehouse module. Original source snapshot preserved at `/tmp/merabetta-user-edits-20261105` before edits. No restored data, new database columns, `.env` changes, phone source changes, Git push, or UAT deployment.

## Behavior

- Native products/details/inventory/warehouses contract, no base_price or child variant rows.
- Distinct product ID per saved size; product edits retain their ID.
- Fixed application import failure after removed model exports.
- Native phone catalog supports root categories, published standalone/variable items, out-of-stock visibility, six-image phone galleries and a served placeholder. Actual unchanged phone validator passed against HTTP responses.
- Atomic product/details/initial-stock creation, reference checks, durable product/image replay records and UUID audit actor recording.
- Warehouse availability, order reservations, settlement and COD stock returns use the new inventory schema. Reset-era orders require reconciliation before touching new stock. In-transit is separate from total on-hand quantities, matching the deployed constraint.
- Native category recursive deletion archives affected listings and retains inventory/audit identity. Image cleanup keeps historical references safe.
- Readable product/inventory audit history and active-vendor dropdown.
- Read-only startup schema checks. Aggregate legacy migration runner now refuses the new schema before any writes.

## Verification

- Syntax: 239 JavaScript files passed.
- ESLint: passed (archived deployment snapshots/diffs excluded).
- Standard suite: 73 passed, 12 opt-in DB suites skipped, zero failures.
- Native local PostgreSQL integration suite: 10 passed, zero skipped/failures. Includes authenticated CRUD, all documented detail fields, replay/concurrency, inventory conservation, transaction rollback, category filtering, audit, mocked S3, deletion and 413 handling.
- Live UAT writes and end-to-end deployment checks were not performed. No schema migration is required by these source changes against the inspected schema; support tables for images, auth, orders and audit must remain present.

## Frontend handoff

See [FRONTEND-INTEGRATION.md](FRONTEND-INTEGRATION.md) and [create-product.json](create-product.json).

## Source files changed relative to the user's snapshot

- `src/server.js`
- `src/app.js`
- `src/shared/image-storage.js`
- `src/shared/catalog-publisher.js`
- `src/shared/product-image-reconciliation.js`
- `src/shared/catalog-idempotency.js`
- `src/routes/index.js`
- `src/app/products/products.controller.js`
- `src/app/products/catalog.js`
- `src/app/products/products.routes.js`
- `src/app/orders/orders.controller.js`
- `src/app/orders/inventory.js`
- `src/admin/variants/variants.controller.js`
- `src/admin/products/products.controller.js`
- `src/admin/products/products.schema.js`
- `src/admin/inventory/cancel-order.js`
- `src/admin/inventory/inventory.routes.js`
- `src/admin/categories/categories.routes.js`
- `package.json`

## Added runtime files

- `src/catalog/categories.js`
- `src/catalog/vendors.js`
- `src/catalog/store.js`
- `src/catalog/catalog.js`
- `src/catalog/fields.js`
- `src/catalog/readiness.js`
- `src/catalog/inventory.js`
- `src/app/products/image-unavailable.png`

Tests and tooling also updated: `scripts/native-catalog-db.test.js`, `test-support/team-schema.sql`, native contract/image/order tests, a stale Redcliffe pagination test expectation, `eslint.config.js`, and the test file discovery command. Existing legacy DB suites remain opt-in; they describe the previous schema and are not validation of the native cutover.
