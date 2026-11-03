# Variant image gallery API

## Routes

All routes use existing admin authentication and Origin validation. Send your allowed
`Origin` on mutations. JSON requests require `Content-Type: application/json`.

Base: `/api/admin/products/:productId` (real database IDs, never size labels).

| Method | Path after base | Request | Success |
| --- | --- | --- | --- |
| GET | `/variants/:variantId/images` | None | 200 gallery envelope |
| POST | `/variants/:variantId/images` | Multipart `uploadimage`, exactly one file | 201 gallery envelope |
| PUT | `/variants/:variantId/images/:imageId` | Multipart `uploadimage`, exactly one file | 200 gallery envelope |
| DELETE | `/variants/:variantId/images/:imageId` | JSON content type, `{}` | 204 |
| PATCH | `/variants/:variantId/images/:imageId/primary` | `{}` | 200 gallery envelope |
| PATCH | `/variants/:variantId/images` | `{"use_product_images":false}` or `true` | 200 gallery envelope |
| POST | `/variants/images/share` | `{"source_variant_id":123}` | 200 gallery envelope + `shared_to_all_variants:true` inside data |

A variant ID must belong to the product in the URL; otherwise 404. Image IDs on
variant PUT/DELETE/primary routes must belong to that variant's **custom** gallery.
Product-image IDs returned as inherited effective images remain product records:
use the existing product routes to edit those, or upload a custom variant image.

## Response example

GET, upload, replacement, primary and mode PATCH return the same envelope:

```json
{
  "data": {
    "product_id": "870516",
    "variant_id": "123",
    "use_product_images": false,
    "effective_source": "variant",
    "custom_images": [
      {
        "id": "901",
        "variant_id": "123",
        "image_url": "https://example.com/image.png",
        "s3_key": "upload/products/870516/<uuid>.png",
        "alt_text": null,
        "sort_order": 0,
        "is_primary": true,
        "created_at": "2026-10-31T00:00:00.000Z"
      }
    ],
    "effective_images": [{"id":"901","variant_id":"123","image_url":"https://example.com/image.png","s3_key":"upload/products/870516/<uuid>.png","alt_text":null,"sort_order":0,"is_primary":true,"created_at":"2026-10-31T00:00:00.000Z"}],
    "primary_image": {"id":"901","variant_id":"123","image_url":"https://example.com/image.png","s3_key":"upload/products/870516/<uuid>.png","alt_text":null,"sort_order":0,"is_primary":true,"created_at":"2026-10-31T00:00:00.000Z"}
  }
}
```

`effective_images` contains full records (not strings); `primary_image` is a full
record or null. In product mode, effective records have `product_id` and IDs from
the product gallery. Never infer gallery type from an ID; use `effective_source`.
Images are ordered by primary first, then sort order, then ID.
An empty custom gallery is exactly `custom_images:[]`, `effective_images:[]`,
`primary_image:null`, `use_product_images:false`; there is no product fallback.

Product GET `/:productId` includes `variants[].use_product_images` and
`variants[].gallery`. Variant GET/list/create/update also include `gallery`.
Published `product_catalog` variant data includes resolved `images`, `image` and
`gallery`; storefront variant offers resolve the exact variant gallery. Empty
custom storefront galleries return `images:[]` and `image:null`.
The existing independent-product storefront remains product based: an independent
product has its own product ID/gallery and does not select legacy variants.

## Modes and sharing

- Existing/new variants default to `use_product_images:true` at the database level.
- Switching to false exposes the stored custom gallery, initially empty. It does
  not copy product images or upload files. Switching true preserves custom images
  so switching back restores them.
- Upload, replace, delete or primary selection operates only on the addressed
  custom gallery and switches that variant to false. Empty remains empty.
- Sharing takes the source variant's **effective** gallery, makes it the product
  default and sets all nondeleted variants on that product to true. Future variants
  default true. Source primary/order are preserved. Sharing an empty custom gallery
  deliberately empties the product default.
- Sharing retains each variant's custom records. Override L by switching L to
  custom or uploading to L; M and XL continue inheriting the shared product default.
- Sharing references existing immutable object keys. It makes no S3 upload/copy.
  Deleting/replacing one record never mutates another record's object. Cleanup
  checks product, variant, category and brand references before deleting storage.
  Hidden custom galleries and soft-deleted variants retain references intentionally.
- Existing independent products may reference legacy product-image records.
  Sharing that would remove such a protected source record returns 409; it does
  not silently change other independent products' galleries.

## Upload limits and retry rules

- Maximum **10 custom images per variant**, independently of product limits.
- JPEG, PNG, WebP, with existing byte-signature validation.
- Exactly one file per variant upload/replacement; maximum **5 MiB per file**.
- Field name `uploadimage`. Browser FormData must set its own multipart boundary;
  do not manually set `Content-Type`.
- Send `Idempotency-Key` on POST uploads, PUT replacements and POST sharing. Reuse
  the same key and identical file/body for retries of one action. Use a new key
  for a different action. Keys: 1–128 letters/digits or `. _ : -`, scoped to admin,
  method and route. Replay returns the original response/status and
  `Idempotency-Replayed:true`, without another upload/mutation. Same key with a
  different file/body returns 409. Without a key, another POST creates a new image.
- Typical errors: 400 invalid file/limit/key, 401 unauthenticated, 403 untrusted
  Origin, 404 ownership mismatch/missing record, 415 incorrect content type,
  422 invalid JSON/IDs, 409 conflicting retry or protected legacy source.
- Storage failure rolls the mutation back; orphan staging objects are journaled
  for cleanup. A deletion storage outage returns committed 204 and retries storage
  cleanup asynchronously rather than reporting a misleading database failure.

```js
const body = new FormData();
body.append('uploadimage', file);
await fetch(`/api/admin/products/${productId}/variants/${variantId}/images`, {
  method: 'POST', credentials: 'include',
  headers: { 'Idempotency-Key': uploadActionKey }, body
});
await fetch(`/api/admin/products/${productId}/variants/images/share`, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': shareActionKey },
  body: JSON.stringify({ source_variant_id: variantId })
});
```

## Migration / release

Additive migration: `sql/038-variant-image-galleries.sql`.

```sh
npm run db:migrate:variant-galleries
```

Adds `product_variants.use_product_images BOOLEAN NOT NULL DEFAULT TRUE` and
`product_variant_images`, indexed by variant/key and one primary per variant.
No existing product images are changed, no image files are copied, and no existing
variant ID is replaced. Migration is rerunnable; existing saved modes are preserved.
Use the configured target database deliberately. Stop old cleanup workers during
release; run migration, deploy all updated workers/API processes, then restart.
Old workers cannot detect variant references and must not coexist with new gallery
writes. Existing UAT already has migration 038 installed; restore the matching API and cleanup code without resetting image modes or rerunning unrelated migrations. Verification must not mutate live galleries.

## Validation

`RUN_VARIANT_GALLERY_DB_TESTS=true` enables
`scripts/variant-galleries-db.test.js` against an explicitly named disposable
`codex_variant_galleries_test*` database. S3 is replaced by an in-memory adapter.
It checks authenticated M/L/XL isolation, concurrent upload retries, sharing without
uploads, future inheritance, custom override, primary/replace/delete, explicit empty
mode, cache/storefront resolution, ownership/security, limits, rollback and deferred
reference-aware cleanup. Run `npm run check` and `npm run lint` too.

Verified against main `911e7da` on 2 November 2026:

- Gallery database suite plus all-seven-routes registration regression: 11 passed.
- Syntax: 196 JavaScript files passed. Lint for all changed runtime/test files passed.
- Full default suite: 54 passed, 4 failed, 5 opt-in suites skipped. The same four
  failures reproduce on unmodified main (catalogue pagination, two payment receipt
  assertions, and a Redcliffe price expectation); these modules are unchanged.
- Full lint has three pre-existing findings in the category controller and SQL log
  sanitizer. Those files are unchanged by the gallery restoration.
- Live UAT verification: all three reported gallery paths return 200 through API
  and CMS; all 25 saved gallery rows are unchanged; all 25 referenced S3 objects
  pass authenticated HEAD checks. Invalid write probes exercise route guards
  without gallery/S3 mutations. Successful writes are verified only in the
  isolated database with mocked S3.
