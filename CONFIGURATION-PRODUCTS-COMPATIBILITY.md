# Individual products with the existing variant editor

Implemented on a feature branch; not deployed or activated. Existing records have not been converted.

## Result and API compatibility

Saving sizes S, M and L through the current product -> variants workflow creates three distinct rows in `products`, each with its own generated product ID, SKU, case-sensitive attributes, price, category assignments, stock ownership and audit history. The existing source product becomes a presentation group (`is_configuration_group=true`), not a sellable stock owner. Old variant rows and their group relationship remain as compatibility records for the current editor, images and historical references. They are not the new purchasable identities.

No form fields, save order, editor URLs or image-gallery workflow change. The frontend adds the actual product ID under each size. Unconverted legacy entries explicitly retain their legacy variant label. The default admin product list stays grouped. For independent records use:

- `GET /api/admin/products?view=individual&limit=100&offset=0`
- `GET /api/admin/products?view=individual&category_id=2` (direct assignments)
- `GET /api/admin/products/:individualProductId`

Existing `POST/PATCH /api/admin/products/:groupId/variants[/:variantId]` keep their request schema, status and variant ID. Responses add:

```json
{"data":{"id":"<legacy variant ID>","product_id":"<UI group ID>","individual_product_id":"<real products.id>","group_product_id":"<UI group ID>","attributes":{"Size":"S"},"stock_quantity":10}}
```

Do not replace the group ID in existing variant/gallery URL paths with the new product ID. `individual_product_id` is the actual product identity. Its mapping is unique and immutable. Existing idempotency handling encloses the variant, product, mapping and initial inventory in one transaction. Lost-response replays retain the same IDs.

Individual GET/list stock reads warehouse inventory for that exact product; stock reservation/deduction never uses group stock. Group and variant edits synchronize shared fields and exact SKU/pricing/attributes through the compatibility layer. Category changes propagate to configurations. Direct configuration PATCH updates the matching editor row and rejects duplicate attribute combinations. Deleting a size archives that product; deleting a group archives its configurations. Stock, reservations, images and order history remain. Recursive category deletion includes independently assigned configuration rows.

Existing product/variant gallery storage stays authoritative; configuration image reads and storefront images resolve its exact effective gallery, including intentionally empty custom galleries. No S3 copy or duplicate image ownership is introduced. Writes use the existing group/variant gallery routes. Direct configuration product image-write endpoints return a clear 409 pointing to that route, preventing ineffective writes to an unused image collection. The existing UI already uses these gallery routes.

The existing remove-all-variants -> switch-to-simple sequence is supported. A simple product with existing warehouse stock cannot silently split it across new sizes; allocation requires explicit review first. The same applies to nested configurations, which are rejected.

## Public products and checkout

With the feature enabled, each independent configuration has public ID `product:<productId>`. Its `productId` is the exact numeric string ID, while `variantId`/`groupProductId` are compatibility metadata. Public category filtering still includes ancestors. Existing `shop:<offerId>` detail/cart/checkout aliases resolve to the matching converted product, preserving saved IDs and historical snapshots. A converted offer is not also emitted as a duplicate catalog listing.

Mixed legacy/new inventory reservation is transactional, aggregates aliases against the same warehouse row before writes, and does not reserve or deduct a size twice on replay. New order-detail rows record the exact `independent_product_id` when available; historical order rows and snapshots are not rewritten.

## Schema, activation and conversion

`CONFIGURATION_PRODUCTS_ENABLED` defaults to false. Leave the older `INDEPENDENT_PRODUCTS_ENABLED` cutover disabled; this compatibility implementation does not use it. Install only separately approved schema `sql/039-configuration-product-compatibility.sql` after verified backups. It requires the already-installed independent inventory/audit prerequisite schema 036; it adds the group flag and immutable configuration links, without converting any rows. Application startup checks this prerequisite before serving when enabled. No dependency install is needed. Do not overwrite .env; any runtime activation must be separately approved.

```bash
npm run db:migrate:configuration-products
```

The command above prints schema instructions only. Actual `-- --apply` requires backup and separate schema approval. New variant saves then create independent products. Existing unconverted variants remain editable and are not silently converted during normal saves.

Conversion uses a read-only repeatable-read preview, a reviewed group scope, and a fingerprint rechecked under table locks. Existing warehouse row IDs, quantities, reservations and legacy offer IDs are retained. Existing non-null warehouse ownership, inconsistent prices, inactive vendor/offer availability, duplicate warehouses and ambiguous group stock block conversion. No S3 calls occur. No global automatic conversion is installed.

```bash
npm run products:configurations:preview -- --groups=998974
```

This writes the local restricted report `CONFIGURATION-PRODUCTS-PREVIEW.json`; it does not mutate the database. If the user explicitly decides to preserve per-variant stock despite a different parent counter, preview again with `--accept-variant-stock` and the same reviewed `--groups` scope. This produces a different fingerprint and only resolves the parent-counter policy; warehouse/pricing conflicts still block. Apply only after separate existing-data approval:

```bash
CONFIGURATION_PRODUCTS_ENABLED=true node scripts/configuration-products.js \
  --groups=998974 --apply --fingerprint='<fresh approved fingerprint>'
```

If the approved policy is per-variant stock, the apply invocation must also contain `--accept-variant-stock`. Never run this against a target inferred from local defaults; confirm the database before any apply.

Read-only UAT findings on 2 November: JOYLIFE group 998974 has parent stock 30; M (variant 220), L (221) and XL (222) each declare 30, totaling 90 in the UI. The strict converter blocks this ambiguity. The user must decide whether 90 across sizes is correct or 30 total needs allocation. Broader legacy stock/availability conflicts also require review. No UAT schema, application, product, inventory, image or order was modified for this implementation.

## Verification and release

Local tests verify real distinct product rows from unchanged variant POSTs, retry identity, grouped/individual views, case preservation, pricing/category propagation, public lookup, image ownership/inheritance, direct configuration edits, exact-size stock reservation/deduction, transaction rollback, archival, fingerprint conversion, legacy public aliases, and variable-to-simple behavior. Separate legacy gallery tests verify the disabled feature preserves existing behavior. Frontend changes are limited to two optional response fields and the ID/help labels; existing tests and TypeScript checks pass.

Release preparation must compare every payload file with UAT, preserve unreviewed server edits, back up the exact replacements and database, perform explicit rsync dry runs, and request approval before remote writes. Deploy via rsync, exclude .env/Git/dependencies/credentials, and reload only root PM2 server ID 0. Keep the previously restored gallery and category patches; these are included as branch dependencies until merged into main.

Before activation/conversion, rollback may restore backed-up application files and leave additive schema in place. After configurations or orders have been created, disabling the feature or reverting to an unaware backend can hide IDs or reject carts: retain compatible readers and prepare a separately reviewed recovery. Do not delete configuration links, restore the entire database over later orders, or erase audit history.

To count active independent configurations in pgAdmin after approved activation/conversion:

```sql
SELECT id, name, sku, attributes
FROM products
WHERE product_status='active' AND deleted_at IS NULL
  AND inventory_managed AND NOT is_configuration_group
ORDER BY id;
```
