# Shared image uploads: frontend handoff

Implemented modules: products, category images and brand logos. All use `src/shared/image_upload.js` for Multer parsing, MIME/content validation and size/count limits, and a shared S3 storage/cleanup service. Existing product routes remain compatible.

## Code organisation

Each admin module contains only its controller, routes and schema files:

| Module folder | Files |
| --- | --- |
| `src/admin/products/` | `products.controller.js`, `products.routes.js`, `products.schema.js` |
| `src/admin/categories/` | `categories.controller.js`, `categories.routes.js`, `categories.schema.js` |
| `src/admin/brands/` | `brands.controller.js`, `brands.routes.js`, `brands.schema.js` |
| `src/admin/variants/` | `variants.controller.js`, `variants.routes.js`, `variants.schema.js` |

Controllers handle resource operations and call shared services. Routes bind HTTP methods, validation schemas and controller functions; they contain no inline business handlers. Schemas define request validation.

Reusable code lives in `src/shared/`: `image_upload.js` (Multer policies and the shared S3 client), `image-signature.js` (byte validation), `image-storage.js` (staging and durable cleanup), `entity-image.controller.js` (single-image controller factory), `product-image-reconciliation.js` (product reconciliation), `catalog-fields.js` (common fields/pricing), `catalog-publisher.js` (publication), and `catalog-idempotency.js` (request replay). Products and categories have no separate local upload/storage helper files. The public endpoint paths and request/response contracts are unchanged by this reorganisation.

## Request rules

- Base URL: your backend API origin, for example `http://localhost:3000`.
- Authenticate with the admin login and its HttpOnly `admin_auth` cookie. Browser fetch requests need `credentials: 'include'`. An app/customer token does not authenticate these routes.
- Browser origin must be permitted by backend `ALLOWED_ORIGINS`. Curl must send `Origin`, for example `Origin: http://localhost:5173`.
- Upload and replacement requests are `multipart/form-data`. The file field is **`uploadimage`**. Do not JSON-encode files or set the multipart `Content-Type` manually; the browser/curl supplies its boundary. Upload bodies contain files only.
- Accepted formats: JPEG, PNG and WebP. The actual bytes must match the declared MIME type.
- Limit: **5 MB per file**. Products: **10 images stored per product**, up to 10 files per upload, **10 MB aggregate per upload**. Category and brand: **one image**, one file per request.
- IDs in URL paths must be positive integers. Treat returned IDs as opaque strings in frontend state.
- Create the product/category/brand with its normal JSON endpoint first; then upload using its returned ID. Multipart uploads are separate from ordinary metadata create/PATCH requests.

## Category image

One main image per category; no separate image ID is needed.

| Method | Endpoint | Success |
| --- | --- | --- |
| POST | `/api/admin/categories/:categoryId/image` | 201; upload or replace the category image |
| PUT | `/api/admin/categories/:categoryId/image` | 200; upload or replace the category image |
| GET | `/api/admin/categories/:categoryId/image` | 200; current image URL, or null |
| DELETE | `/api/admin/categories/:categoryId/image` | 204; clear the image |

POST and PUT are aliases for assigning the single category image; prefer PUT in the editor. Both require exactly one `uploadimage` file. A successful response is:

```json
{
  "data": {
    "category_id": "12",
    "image_url": "https://prod-merabetta.s3.ap-south-1.amazonaws.com/upload/categories/12/12345678-1234-1234-1234-123456789abc.png"
  }
}
```

The category record itself uses **`category_image`**: `GET /api/admin/categories/:categoryId`, category lists and the category tree return that field with the saved URL. The image-specific routes use the consistent `image_url` response field shown above.

GET on an existing category without an image returns `image_url: null`. DELETE is idempotent for an existing category whose image is already empty. A missing category returns 404.

## Brand logo

One logo per brand; no separate image ID is needed.

| Method | Endpoint | Success |
| --- | --- | --- |
| POST | `/api/admin/brands/:brandId/image` | 201; upload or replace the brand logo |
| PUT | `/api/admin/brands/:brandId/image` | 200; upload or replace the brand logo |
| GET | `/api/admin/brands/:brandId/image` | 200; current logo URL, or null |
| DELETE | `/api/admin/brands/:brandId/image` | 204; clear the logo |

POST/PUT require exactly one `uploadimage` file. Response:

```json
{
  "data": {
    "brand_id": "3",
    "image_url": "https://prod-merabetta.s3.ap-south-1.amazonaws.com/upload/brands/3/12345678-1234-1234-1234-123456789abc.webp"
  }
}
```

The brand create/PATCH/detail/list APIs also call the field **`image_url`**. The backend maps it to `brands.logo_url` in PostgreSQL; do not send `logo_url` in frontend JSON requests. GET with no logo returns null; DELETE of an already-empty logo returns 204. Missing brands return 404.

## Product gallery (existing routes, shared upload handling)

| Method | Endpoint | Success |
| --- | --- | --- |
| POST | `/api/admin/products/:productId/images` | 201; array of newly created image records |
| GET | `/api/admin/products/:productId/images` | 200; array of all stored image records |
| PUT | `/api/admin/products/:productId/images/:imageId` | 200; replace one existing image |
| DELETE | `/api/admin/products/:productId/images/:imageId` | 204; remove one image |
| PATCH | `/api/admin/products/:productId/images/:imageId/primary` | 200; choose the primary image |

POST appends new images; it does not replace the entire gallery. Append `uploadimage` once per new file. Existing stored images count toward the limit of 10. Do not re-upload existing previews just because the edit form was opened.

PUT takes exactly one `uploadimage` file and preserves the database image ID. Replacement creates a new immutable storage object: **the image URL and S3 key can change**. Always use the returned `image_url`, not a reconstructed or cached URL. The old object is removed asynchronously after the database commits.

POST/GET response shape:

```json
{
  "data": [{
    "id": "44",
    "product_id": "120",
    "image_url": "https://prod-merabetta.s3.ap-south-1.amazonaws.com/upload/products/120/12345678-1234-1234-1234-123456789abc.png",
    "s3_key": "upload/products/120/12345678-1234-1234-1234-123456789abc.png",
    "alt_text": null,
    "sort_order": 0,
    "is_primary": true
  }]
}
```

PUT and primary-selection responses use `{ "data": imageObject }`. GET ordering is primary first, then `sort_order`, then ID. Deleting the primary image promotes the next one. Refetch the gallery after deletes and primary changes. There is currently no independent alt-text or sort-order edit route.

For PATCH primary and every DELETE, use `Content-Type: application/json` and send `{}`. Do not try to parse a JSON response from a successful 204.

Product POST uploads retain the existing optional `Idempotency-Key` header: 1-128 letters, digits, `.`, `_`, `:` or `-`. Reuse the key with the same files to safely retry; a changed payload with the same key returns 409. Category/brand singleton uploads do not currently implement idempotency-key replay.

## Frontend example

The same function can upload a category image or brand logo:

```javascript
const API_ORIGIN = 'http://localhost:3000';

async function saveEntityImage(resource, id, file) {
  // resource is 'categories' or 'brands'.
  const body = new FormData();
  body.append('uploadimage', file);
  const response = await fetch(
    `${API_ORIGIN}/api/admin/${resource}/${encodeURIComponent(id)}/image`,
    { method: 'PUT', credentials: 'include', body }
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || result.message || 'Image upload failed');
  }
  return result.data.image_url;
}

// Update the preview from this returned URL.
const categoryImageUrl = await saveEntityImage('categories', categoryId, file);
```

Delete helper:

```javascript
async function deleteEntityImage(resource, id) {
  const response = await fetch(
    `${API_ORIGIN}/api/admin/${resource}/${encodeURIComponent(id)}/image`,
    {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }
  );
  if (response.status === 204) return;
  const result = await response.json();
  throw new Error(result.error || result.message || 'Could not delete image');
}
```

Curl examples using an existing authenticated cookie jar:

```sh
curl -X PUT 'http://localhost:3000/api/admin/categories/12/image' \
  -b cookies.txt -H 'Origin: http://localhost:5173' \
  -F 'uploadimage=@/absolute/path/category.png;type=image/png'

curl -X PUT 'http://localhost:3000/api/admin/brands/3/image' \
  -b cookies.txt -H 'Origin: http://localhost:5173' \
  -F 'uploadimage=@/absolute/path/logo.webp;type=image/webp'

curl -X POST 'http://localhost:3000/api/admin/products/120/images' \
  -b cookies.txt -H 'Origin: http://localhost:5173' \
  -F 'uploadimage=@/absolute/path/front.png;type=image/png' \
  -F 'uploadimage=@/absolute/path/back.jpg;type=image/jpeg'
```

## Error and save handling

| HTTP | Meaning |
| --- | --- |
| 400 | Missing/wrong file field, too many files, oversized files/batch, unsupported MIME or mismatched image bytes |
| 401 | Admin session missing/expired |
| 403 | Origin not permitted |
| 404 | Parent resource or product image does not exist |
| 409 | Existing product idempotency conflict or image staging expired; refetch/retry as appropriate |
| 415 | POST/PUT image request was not multipart, or an ordinary write was not JSON |
| 422 | Invalid path ID |
| 500 | Storage/database failure; preserve the current image and show a retry action |

Normal error body is `{ "error": "message" }`; some existing product validations may use `message`. Keep existing form data on failure. If entity metadata saves successfully but its subsequent image request fails, retry the image operation rather than creating another entity.

Upload/replace persists the URL in the owning entity. Delete clears the URL immediately and queues storage cleanup. Replacement failures preserve the previous committed image. Cleanup retries storage outages and protects objects still referenced by products, categories or brands. External image URLs are never deleted from external storage. Clearing/replacing image URL fields through the existing category/brand JSON PATCH routes also queues safe cleanup of old managed images.

## Deployment and reuse

No new image columns or entity-specific image tables are required. The shared storage service reuses the existing `product_image_cleanup` journal from migration `027-admin-catalog-reliability.sql`. If that migration has not been deployed, run `npm run db:migrate:catalog-reliability` through the normal deployment workflow before enabling uploads. Restart/deploy the updated backend. No live schema migration was run during this implementation.

Other backend modules can reuse `createImageUpload()` with their own file-count policy. The reusable image controller factory is `createEntityImageControllers()` in `src/shared/entity-image.controller.js`; each module keeps its endpoint definitions in its own routes file. Storage resource names and reference guards are registered server-side; this does not expose an arbitrary public upload path or automatically add upload endpoints for unrelated modules such as banners or profiles.

Verification: shared Multer/content/size tests passed; authenticated category/brand CRUD and failure recovery passed against a disposable PostgreSQL database; the existing product image replay, replacement, rollback, cleanup and reconciliation suite passed against a separate disposable database. S3 was mocked in these tests; no live category or brand images were modified.
