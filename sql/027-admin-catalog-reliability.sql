-- Kept independently of products so cascade deletion cannot discard cleanup work.
CREATE TABLE IF NOT EXISTS product_image_cleanup (
 s3_key TEXT PRIMARY KEY,
 not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_image_cleanup_due_idx ON product_image_cleanup(not_before);
CREATE TABLE IF NOT EXISTS admin_catalog_requests (
 id VARCHAR(64) PRIMARY KEY,
 fingerprint VARCHAR(64) NOT NULL,
 status INTEGER NOT NULL,
 body JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
