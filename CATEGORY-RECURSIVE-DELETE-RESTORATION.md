# Restore recursive category deletion

The deployed controller blocks deletion whenever products or subcategories exist, despite the recursive service already being installed. Restore the controller call and authenticated read-only preview, preserving DELETE 204 compatibility and allowing optional summary/fingerprint query parameters.

Deleting a parent removes every descendant category and archives all linked products/variants. Inventory, orders, images and audit history remain. Authentication, atomic transactions, schema checks and unknown dependency protections remain enabled. No data is deleted by deployment.

UAT runtime payload is only the three src/admin/categories/categories.{controller,routes,schema}.js files. Supporting helpers in this PR are already on UAT and identical to their captured versions. Migration 037 is already installed and read-only category 38 preview reports no missing migrations or blockers. No dependency installation is needed. Fresh environments require the independent catalog/audit schema before 037; do not run migrations without separate approval.

Validation: 13 database integration checks passed against disposable local fixtures using the existing full development schema with the exact category controller/routes/schema overlaid; 2 tree checks plus route-registration check and changed-file lint passed. Tests cover recursive removal, linked-product archival, history/inventory/order/image preservation, stale caches, rollback and authentication. No successful live deletion was attempted.

UAT category 38 read-only preview: 2 categories including 1 descendant; 3 linked products and 3 variants would be archived; 1 inactive stale catalog projection cleaned. No deletion was executed.

Deployment requires approval. Back up and hash-verify the existing three files; rsync the reviewed explicit file list without --delete; reload only root PM2 server ID 0. Preserve .env and all unrelated code, including variant galleries. Verify health and authenticated preview through API and CMS. Rollback restores only these three backed-up files and reloads server ID 0; no database rollback is necessary before any business deletion.
