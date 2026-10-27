# Catalog retries and image recovery

These changes cover backend reliability only. Product fields, category subtree semantics, and image-count limits are unchanged. No deployment migration or live S3 cleanup was performed during implementation.

## Deployment

For an existing catalog installation, apply the additive, repeatable migration before starting the updated API:

```sh
npm run db:migrate:catalog-reliability
```

This applies `sql/027-admin-catalog-reliability.sql`, creating `admin_catalog_requests` and `product_image_cleanup`. It avoids the unrelated legacy bootstrap steps in `scripts/migrate.js`. The full bootstrap also includes the new migration. No existing product columns are altered.

The API starts a cleanup worker on startup, polling every 30 seconds. Multiple API processes can run it: PostgreSQL row locks and `SKIP LOCKED` coordinate jobs. Failures remain queued with capped exponential backoff (30 seconds through one hour), an attempt count, and the latest error. Logs report worker failures. Monitor queue age, attempts and errors:

```sql
SELECT s3_key, not_before, attempts, last_error, created_at
FROM product_image_cleanup
ORDER BY created_at;
```

S3 permissions must cover PutObject, GetObject/HeadObject and DeleteObject for both legacy `upload/:id[a-j].ext` objects and the new `upload/products/:id/:uuid.ext` prefix. Reconciliation also requires ListBucket on `upload/`. Direct image-read policy must cover the new prefix. Stop old writers that reuse storage keys before enabling reconciliation repairs. Versioned buckets may retain historical versions under their configured lifecycle policy.

## Frontend retry contract

Send an `Idempotency-Key` on these POST requests:

- `/api/admin/products`
- `/api/admin/products/:productId/images`
- `/api/admin/products/:productId/variants`

Use a unique key per logical operation, such as `crypto.randomUUID()`. Persist and reuse it with the same payload after a timeout or lost response. Use a new key for a different operation. Allowed characters: letters, digits, `.`, `_`, `:`, `-`; maximum 128 characters. Support is optional for compatibility: requests without the header do not gain replay protection.

Keys are scoped to the authenticated admin and exact endpoint path. Concurrent identical retries serialize and replay the original status/body with `Idempotency-Replayed: true`. Changed payloads using the same key return 409. JSON object key order is ignored; array order is significant. Upload fingerprints include each file's content and MIME type in upload order, without multipart boundaries or filenames. Validation still runs on retries.

The replay record and database mutation commit in one transaction. Failed transactions can retry the same key. Records are retained without automatic expiry; deleting them would remove replay protection. A replay returns the original response even if the record was subsequently edited or deleted, so fetch fresh state before further editing. Idempotency does not restore deleted data.

CORS permits `Idempotency-Key` and exposes `Idempotency-Replayed`. Existing cookies, Origin checks, JSON Content-Type requirements, and 16 KiB JSON-body limits still apply. Multipart uploads keep their existing limits.

## Storage behavior

Every new object gets an immutable UUID key. A separately committed staging journal exists before S3 is written. The upload transaction locks that journal so cleanup cannot delete an in-flight upload. Journals are reserved before taking a transaction connection to avoid exhausting the connection pool with nested reservations.

A successful transaction creates or switches the image reference and removes the staging journal atomically. Rollbacks, uncertain PutObject outcomes, process interruption, and unused reservations leave journals available for cleanup after one hour. A lost response after commit can be replayed with its idempotency key. Cleanup checks current image references before deleting an object.

Replacement retains the old object until the new image reference commits. The old key is queued for deletion in the same transaction. Image and product deletion likewise queue keys before deleting database rows. S3 failure does not turn a committed database deletion into a failed HTTP response. A successful delete means cleanup was durably queued, not that the object is already physically gone.

Image signatures are checked for JPEG, PNG and WebP and must match MIME declarations. This is container/signature validation, not complete image decoding or malware scanning.

## Reconciliation

Report missing database references and orphaned managed objects without changing either system:

```sh
npm run images:reconcile
```

Apply repairs explicitly:

```sh
npm run images:reconcile -- --apply
```

Apply mode rechecks definitive missing-object responses while holding the parent product lock, removes dangling image rows, promotes another primary image when needed, and republishes the catalog. Missing image bytes cannot be reconstructed; this removes broken references. Permission errors, throttling and transport failures are not treated as missing files.

Orphan cleanup only considers recognized catalog key patterns older than 24 hours. It ignores unrelated bucket objects. Candidates are queued durably and checked again for database references before deletion. Existing staging-job locks protect in-flight uploads. A run may commit individual repairs before a later error; rerunning is safe. The command drains up to 20 due jobs; the API worker continues draining the queue. Schedule the command externally if recurring full reconciliation is needed; the API worker handles queued cleanup only.

## Verification

`npm test` includes signature tests. Database suites are opt-in and require a disposable database. The new suite requires a name starting with `codex_catalog_reliability_test`; it truncates fixtures and replaces every S3 call with a fake. Set explicit test DB connection variables, `NODE_ENV=test`, `DB_SSL=false`, and `RUN_CATALOG_RELIABILITY_DB_TESTS=true`, then run:

```sh
node --import ./test-support/env.js --test scripts/catalog-reliability-db.test.js
```

It exercises real admin login/session cookies/logout, concurrent replay and payload conflicts, actor scoping, upload rollback, replacement and deletion failures, worker locking/retries, product cascade cleanup, case-sensitive variants, manual pricing, pagination/sorting, and reconciliation. Actual Next proxy forwarding, production Secure cookies, deployed migrations and S3 permissions still need environment verification.
