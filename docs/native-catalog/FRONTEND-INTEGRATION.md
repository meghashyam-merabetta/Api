# Native catalog API — frontend handoff

Status: implemented and tested locally against the team's native schema. This document does **not** claim UAT deployment. No phone source changes or data restoration are required by this implementation.

## Identity and save flow

Each `products.id` is one purchasable item/configuration. S, M, and L require three POST requests and receive three different product IDs. There is no extra parent product and no `product_variants` table. Use the same product editor for each item. `product_type: "variable"` is descriptive; it does not create children or hide the row from the phone catalog.

1. Load category/brand/vendor/warehouse dropdowns.
2. POST one product with its `details` and optional `initial_inventory`.
3. Retain returned `data.id` immediately; upload its images separately.
4. PATCH that ID for later edits. Do not POST again after an image/stock failure.
5. For another size, POST a different product code, slug and SKU, with its own details, stock and images. Optional `product_group_code` connects peer items for the CMS related-items list; it is stored inside `details.additional_attributes`, not a new SQL column.

There is no `base_price`. Use `mrp`, `selling_price`, `cost_price`, and `tax_rate`. Do not send old `offer_percent`, `attributes`, `category_ids`, `parent_product_id` or nested `variants` fields. Legacy `regular_price`/`sale_price` aliases remain accepted, but prefer native names. Never send conflicting aliases.

## Authentication and transport

Browser base path: `/api/admin`; use the existing same-origin proxy with `credentials: 'include'`. Login: POST `/api/admin/auth/login` with `{ "email": "<admin email>", "password": "<password>" }`. Session check: GET `/api/admin/auth/me`. Use the same origin/cookie jar for subsequent calls; cookies obtained from an IP address do not authenticate requests to a domain.

JSON writes (including DELETE) use `Content-Type: application/json` and an allowed browser Origin. Multipart requests use FormData with no manually constructed Content-Type boundary. Product JSON bodies are limited to **128 KiB**; other JSON routes retain 16 KiB. A larger body returns 413. Responses with 204 have no JSON body.

Send a stable `Idempotency-Key` on product POST and image POST/PUT (1–128 letters, digits, `.`, `_`, `:`, `-`). Reuse the same key and payload after timeout. Replay returns the saved status/body plus `Idempotency-Replayed: true`; changing the payload under the same key returns 409. A different key creates a new operation. Product code, SKU and slug uniqueness also prevent duplicate identities.

IDs in responses are bigint strings. Request IDs are positive safe JSON integers; convert only after checking `Number.isSafeInteger`. Decimal database values may be strings: convert for display/calculation. Never generate the database ID in the frontend.

## Routes

All routes below require an admin session. Paths are relative to `/api/admin`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/products?limit=20&offset=0` | Flat list; every configuration has its own row |
| POST | `/products` | Create product + details + optional initial inventory atomically; 201 |
| GET | `/products/:id` | Product, details, images and inventory summary |
| PATCH | `/products/:id` | Partial update; preserves ID; 200 |
| DELETE | `/products/:id` | Archive/soft-delete; retain inventory/history; 204 |
| GET | `/products/:id/related?limit=20&offset=0` | Other rows sharing `product_group_code` |
| GET | `/products/:id/inventory` | Warehouse rows and aggregate quantities |
| PUT or PATCH | `/products/:id/inventory` | Set absolute quantities for one warehouse |
| GET | `/products/:id/inventory-history?limit=20&offset=0` | Native inventory audit entries |
| GET | `/products/:id/audit-history?limit=20&offset=0` | Product and inventory audit entries |
| GET/POST | `/products/:id/images` | List/upload images; POST returns 201 |
| PUT/DELETE | `/products/:id/images/:imageId` | Replace/delete one image |
| PATCH | `/products/:id/images/:imageId/primary` | Select primary image, JSON `{}` |
| GET | `/categories?roots_only=true&limit=100&offset=0` | Root category dropdown |
| GET | `/categories?parent_category_id=:id&limit=100&offset=0` | Children of a category |
| GET | `/categories/tree` | Full category tree |
| GET | `/brands?limit=100&offset=0` | Brand dropdown |
| GET | `/vendors?limit=100&offset=0` | Active vendor dropdown (id/name/status) |
| GET/POST | `/warehouses` | List/create warehouse |
| GET/PATCH/PUT/DELETE | `/warehouses/:id` | Read/update/deactivate warehouse |

Product list filters: `category_id`, `subcategory_id`, `brand_id`, `vendor_id`, `product_group_code`, `product_status`, `is_active=true|false`, `search`. Sorting: `sort_by=product_id|product_name|product_code|sku`, `sort_order=asc|desc`. Default limit 20, maximum 100. Pagination returns `{ "data": [], "pagination": { "total": 0, "limit": 20, "offset": 0, "hasMore": false } }`.

Categories remain the existing hierarchy table. `category_id` must be a root; `subcategory_id` is optional and must descend from that root. No new category/subcategory tables are created. Category IDs can be omitted for a draft; assign a category for phone visibility.

## Create request

Use [create-product.json](create-product.json) for the complete supported field example. Replace category/warehouse IDs with actual dropdown values. All `product_details` business fields are inside `details`.

Minimal request:

```json
{
  "product_code": "BP-1000MAH",
  "product_name": "BP Machine 1000 mAh",
  "slug": "bp-machine-1000mah",
  "sku": "BP-1000MAH",
  "category_id": 1,
  "product_status": "active",
  "mrp": 1000,
  "selling_price": 900,
  "details": { "size": "1000 mAh", "colour": "White" }
}
```

Returns 201, `Location: /api/admin/products/<id>` and `{ "data": { "id": "<id>", "product_code": "BP-1000MAH", "product_name": "BP Machine 1000 mAh", "mrp": "1000.00", "selling_price": "900.00", "details": { ... }, "images": [], "inventory": { ... }, ... } }` (illustrative excerpt).

Required create fields: `product_code`, `product_name`, `slug`. Status defaults to `draft`. Status values: `draft`, `active`, `inactive`, `archived`. Type values: `simple`, `variable`, `grouped`, `bundle`. Prices are nonnegative JSON numbers with at most two decimals; selling price cannot exceed MRP. No automatic percentage recalculation.

Database-generated `id`, timestamps, `is_deleted`, `created_by`, and `updated_by` are not writable. Admin identity is UUID whereas the supplied creator columns are bigint; audit actor identity goes to the existing `audit_logs` table instead.

## Update request

PATCH `/api/admin/products/<saved-id>`:

```json
{
  "selling_price": 850,
  "details": {
    "size": "1000 mAh",
    "specifications": { "Battery": "1000 mAh", "Display": "LCD" }
  }
}
```

Omitted scalar/detail fields stay unchanged. Supplied JSON arrays/objects replace the corresponding field; send the full `specifications` or `additional_attributes` object to preserve other keys. Names/values remain case-sensitive. Supply `product_group_code` alongside a replacement `additional_attributes` object if that group should remain attached. Use `null` only for nullable fields; use `[]`/`{}` to clear arrays/objects.

## Stock and warehouses

Create a warehouse with POST `/warehouses`, for example:

```json
{ "warehouse_code": "MAIN", "warehouse_name": "Main warehouse", "city": "Pune", "state": "Maharashtra", "country": "India", "pincode": "411001", "is_active": true }
```

Warehouse fields also include `warehouse_type`, `contact_person`, `contact_number`, `email`, `address_line1`, `address_line2`. Existing inventory prevents warehouse deactivation.

Set stock with PUT `/products/<id>/inventory`:

```json
{
  "warehouse_id": 1,
  "total_quantity": 30,
  "available_quantity": 28,
  "damaged_quantity": 2,
  "in_transit_quantity": 5,
  "minimum_stock_level": 5,
  "maximum_stock_level": 100,
  "reorder_quantity": 20,
  "rack_number": "A",
  "shelf_number": "2",
  "bin_number": "BP"
}
```

Quantities are absolute, not increments. Available + reserved + damaged must not exceed total. In-transit stock is separate, matching the deployed constraint. Reserved stock is owned by order reservation/settlement; do not edit it. Omitted inventory fields preserve existing values or default to zero/null on first creation. All quantities are nonnegative integers. An initial inventory row uses the same fields plus required `total_quantity`; omitted available quantity defaults to total minus damaged stock, and initial reserved quantity must be zero.

Product `stock_quantity` is maintained from active warehouse availability. For creation, omit it or match initial available quantity; later change warehouse inventory instead. Stock writes require `inventory.adjust`, `admin.manage` or `*` permission. Delta `/inventory/adjustments` is intentionally unsupported; use absolute inventory writes.

## Images

Use multipart field `uploadimage` (repeat for multiple files). JPEG, PNG and WebP are checked by file signature. Maximum 5 MiB per file, 10 MiB per request, ten images per product. The frontend may keep its six-image additions policy while allowing existing larger galleries to be edited. Replacement requires exactly one file. List/upload return arrays with `id`, `product_id`, `s3_key`, `image_url`, `sort_order`, `is_primary`; replacement/primary returns one image object. Delete returns 204.

Image operations are separate from product creation; retain the saved product ID on image failure. Database deletion/replacement schedules durable storage cleanup. Soft-deleting a product retains its gallery/history; it is removed from public listings.

## Phone app compatibility and rollout

GET `/api/app/products/catalog` supplies the existing phone contract. Published, active, nondeleted products with valid prices and active taxonomy/brand are returned, including variable products without children and out-of-stock listings. Root category membership and descendant IDs are included. Images are capped at six for the phone; missing images use a backend-served placeholder. Individual IDs remain distinct (`id: "product:<id>"`, `productId: "<id>"`).

GET `/api/app/products?category=<category-id>&limit=100&offset=0` filters by category or ancestor. GET `/api/app/products/<id>` reads one listing. No vendor offer or old `product_variants` row is required. A direct database consumer must use the native tables and joins; these HTTP compatibility changes cannot modify external SQL.

No schema migration or old-data restore is included in this change. Startup checks the supplied physical columns. Do not run the legacy aggregate migration command against the reset database: it would recreate old tables/columns. Deploy the coordinated source changes only after server-diff review, backup, and approval; never upload `.env`.
