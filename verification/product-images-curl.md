# Live product image curl results

Tested against the configured PostgreSQL database and real `prod-merabetta` S3 bucket. The test starts the full Express app on a temporary local port and uses actual curl subprocesses and admin-cookie authentication. No workers are started. All 24 live checks passed after applying the approved compatibility migration.

| Check | HTTP | Result |
| --- | --- | --- |
| Admin login / temporary product creation | 200 / 201 | Passed |
| Upload two PNG images | 201 | Passed |
| Read image from returned S3 URL | 200 | Passed; downloaded bytes match upload |
| List images and primary ordering | 200 | Passed |
| Set primary image | 200 | Passed |
| Replace image with PUT multipart | 200 | Passed; ID and storage key preserved, URL refreshed |
| Read replacement from S3 | 200 | Passed; downloaded bytes match replacement |
| Publish and retrieve images afterward | 200 | Passed |
| Invalid MIME / missing replacement file | 400 | Passed |
| Invalid image ID | 422 | Passed |
| Missing image / repeated deletion | 404 | Passed |
| Untrusted upload origin | 403 | Passed |
| Delete primary and promote remaining image | 204 / 200 | Passed |
| Delete remaining image and verify empty list | 204 / 200 | Passed |
| Product-detail response containing image associations | 200 | Passed; both uploaded images returned |

All temporary products, admin accounts, sessions and S3 objects were removed. No existing product images were changed. The approved `025-admin-catalog-compatibility.sql` migration was applied transactionally before the final successful run.

The tests exposed and fixed the request guard rejecting multipart PUT replacement. Multipart image writes now also require a trusted Origin. The brand image model now maps to the existing `logo_url` database column.

The initial run exposed missing variant columns in the existing database. The approved compatibility migration added `regular_price`, `sale_price`, `stock_quantity`, and `updated_at` while retaining existing rows. Product-detail retrieval now succeeds.

## Repeat the automated live curl test

```sh
NODE_ENV=test LOG_LEVEL=silent LOG_API_PAYLOADS=false LOG_SQL=false \
  node scripts/check-product-images-curl.js
```

This script writes temporary fixtures to the configured database and bucket and cleans them up. It exits unsuccessfully if any check fails.

## Manual curl requests

Set `BASE`, `ORIGIN`, `PRODUCT_ID`, and `IMAGE_ID` for your environment. Use a test product. Authenticate with your own admin credentials and retain the cookie jar:

```sh
BASE=http://localhost:3000/api/admin
ORIGIN=http://localhost:5173

curl -i -c /tmp/image-test-cookies.txt \
  -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_ADMIN_EMAIL","password":"YOUR_ADMIN_PASSWORD"}' \
  "$BASE/auth/login"

# Upload: 201. Let curl generate the multipart Content-Type and boundary.
curl -i -b /tmp/image-test-cookies.txt -H "Origin: $ORIGIN" \
  -F 'uploadimage=@/absolute/path/first.png;type=image/png' \
  "$BASE/products/$PRODUCT_ID/images"

# List: 200. Use an image ID from data[].id.
curl -i -b /tmp/image-test-cookies.txt \
  "$BASE/products/$PRODUCT_ID/images"

# Choose primary: 200.
curl -i -X PATCH -b /tmp/image-test-cookies.txt \
  -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{}' \
  "$BASE/products/$PRODUCT_ID/images/$IMAGE_ID/primary"

# Replace: 200. The replacement uses PUT and multipart, not PATCH/JSON.
curl -i -X PUT -b /tmp/image-test-cookies.txt -H "Origin: $ORIGIN" \
  -F 'uploadimage=@/absolute/path/replacement.png;type=image/png' \
  "$BASE/products/$PRODUCT_ID/images/$IMAGE_ID"

# Delete: 204.
curl -i -X DELETE -b /tmp/image-test-cookies.txt \
  -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{}' \
  "$BASE/products/$PRODUCT_ID/images/$IMAGE_ID"
```
