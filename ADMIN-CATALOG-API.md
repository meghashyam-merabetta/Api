# Admin catalog corrections

The full core-schema mapping, variant barcode/weight fields, customer catalog and checkout behavior are documented in [PRODUCT-SCHEMA.md](PRODUCT-SCHEMA.md).

These APIs use the existing admin authentication under `/api/admin`. For existing catalog deployments, run `npm run db:migrate:catalog-reliability` before deploying this reliability update. The original catalog bootstrap is `npm run db:migrate`. The original bootstrap adds catalog base tables, existing product detail columns, and variant tables. The reliability migration adds only request-replay and cleanup tables; existing catalog rows are retained. Migrations are not run on application startup.

## Categories

- `GET /categories/tree` returns nested `subcategories` for the full hierarchy. Optional `is_active=true|false` filters the tree.
- `GET /categories?roots_only=true` returns paginated root categories.
- After selecting a category, fetch its immediate children with `GET /categories?parent_category_id=123` and its directly assigned products with `GET /products?category_id=123`.
- The existing unfiltered category list remains available. The frontend controls when children and products become visible.

## Brands

`GET /brands`, `GET /brands/:brandId`, `POST /brands`, `PATCH /brands/:brandId`, and `DELETE /brands/:brandId` support listing and CRUD.

Create a brand with `{ "brand_name": "Joylife", "slug": "joylife", "is_active": true }`. Optional fields: `description`, `image_url`. PATCH accepts any subset. Deletion returns 409 while products reference the brand; reassign or clear those products' `brand_id` first.

List filters: `search`, `is_active=true|false`, `limit` (1–100), `offset`. For a complete brand selector, use `GET /brands?all=true`; otherwise follow `pagination.hasMore`. Lists are sorted by brand name and ID.

## Products and pricing

Existing create and PATCH endpoints accept:

- Identity and inventory: `product_code`, `sku`, `product_type` (`simple` or `variable`), `stock_quantity`, `min_order_quantity`, `max_order_quantity`.
- Prices: `regular_price` (MRP), `sale_price` (offer price), `offer_percent`. `mrp` and `offer_price` are accepted as input aliases. Responses use `regular_price` and `sale_price`.
- Discounts: `special_discount_enabled`, `special_discount_percent`, `festival_offer_enabled`, `festival_offer_percent`.
- Product details: `target_audience`, `hsn_code`, `gst_rate`, `weight`, `weight_unit` (`g` or `kg`), `unit_count`, `package_length`, `package_breadth`, `package_height`, `dimension_unit` (`cm`, `mm`, `in`), `material`, `colour`, `package_type`, `shelf_life`, `water_resistant`, `hazardous_clause`, `manufactured_in`, `company_name`, `company_address`, `packer_name`, `packer_address`, `keywords` (array of separate strings).

Money inputs are nonnegative numbers with at most two decimal places. Sale price cannot exceed MRP. Percentages are 0–100. If `offer_percent` is set, the backend calculates `sale_price` from MRP, including on later MRP changes. Set `offer_percent: null` to switch to an explicit offer price. Sending conflicting aliases is rejected. PATCH validates prices and quantity limits against the stored record.

`effective_price` is returned with products. It starts with sale price (or MRP when sale price is absent), then applies the enabled special discount, followed by the enabled festival discount, rounding to paise after each step. For MRP 100, offer price 80, special discount 10%, and festival discount 5%, it is 68.40. GST is stored as product metadata; these APIs do not add GST to prices. Discounts apply whenever their flag is enabled; scheduled festival dates are not specified by the correction sheet.

Product lists accept `sort_by=product_name|product_code|sku|product_id`, `sort_order=asc|desc`, and `brand_id`, alongside existing filters. Search covers name, product code, SKU, and exact keyword entries. Product list and detail responses include `brand`, ordered `images`, and `variants`. Decimal database values may be serialized as strings; handle them numerically on the frontend.

## Separate variant options and product sizes

Manage definitions with `GET/POST /variant-attributes` and `PATCH/DELETE /variant-attributes/:attributeId`:

```json
{ "name": "Size", "values": ["M", "L", "XL", "XXL"] }
```

Comma-separated combined options are rejected. Renaming an attribute, removing existing options, or deleting a definition in use returns 409. Adding options is allowed.

Set `product_type: "variable"` on the product, then use:

- `GET/POST /products/:productId/variants`
- `PATCH/DELETE /products/:productId/variants/:variantId`

Create each size as its own record:

```json
{
  "sku": "JOY-M",
  "attributes": { "Size": "M" },
  "regular_price": 999,
  "sale_price": 799,
  "stock_quantity": 25,
  "is_active": true
}
```

Each record has its own ID, SKU, stock, optional prices, and `display_name` (for example `M` or `M / Blue`). Attribute names and values must exist in the definitions. Duplicate SKUs and duplicate attribute combinations within a product return 409. To change a variable product back to simple, remove its variants first. Variant deletion and updates are scoped to their parent product. Definition and per-product variant lists accept `limit` and `offset`.

## Product images

Image endpoints use multipart field `uploadimage`. JPEG, PNG, and WebP content signatures must match their declared MIME types. Limits remain 10 images per product, 5 MiB per file, and 10 MiB total per upload request. The frontend may retain its stricter six-image addition policy.

New uploads use immutable UUID keys under `upload/products/:productId/`; existing A–J keys remain readable. Replacement preserves the image ID but returns a new `s3_key` and `image_url`. Always consume the returned metadata rather than deriving a key or adding a query parameter to an old URL.

Product list/detail and `GET /products/:productId/images` return image metadata ordered primary first. Replacement uploads the new object before switching the database reference. Image and product deletion commit database changes together with durable storage-cleanup jobs. S3 deletion runs afterward and retries on failures. A 204 means database deletion and cleanup intent committed; physical storage removal is eventual.

Storage uses `prod-merabetta` in `ap-south-1` and direct S3 URLs. The bucket must permit intended image reads, including the new key prefix. Current verification uses isolated PostgreSQL and mocked S3; live proxy/cookie/HTTPS and IAM behavior remain deployment checks. See [catalog reliability operations](CATALOG-RELIABILITY.md) for migration, retry headers, recovery, and reconciliation.

## Frontend work

Use the hierarchy/selector APIs above to branch categories and display each variant option separately. Use returned `images` when reopening an existing product. The edit-page title (`Add New Product` versus `Edit Product`) and visual tabs are frontend changes and are not controlled by these backend routes.

## Verification

`npm test` includes price/validation unit tests. The database integration suite is opt-in and requires a disposable PostgreSQL database named with the `codex_catalog_test` prefix. It truncates catalog fixtures in that database. Set `RUN_CATALOG_DB_TESTS=true` and explicit `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL=false`, and `NODE_ENV=test`, then run:

```sh
node --import ./test-support/env.js --test scripts/admin-catalog-db.test.js
```

The integration suite applies migrations twice, exercises CRUD and hierarchy validation over HTTP, verifies listing associations and individual variants, and checks image primary selection, replacement, and rollback with mocked storage.
