-- Additive: existing variants inherit the unchanged product gallery.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS use_product_images BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS product_variant_images (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 variant_id BIGINT NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
 image_url TEXT NOT NULL,
 s3_key TEXT NOT NULL,
 alt_text VARCHAR(255),
 sort_order INTEGER NOT NULL DEFAULT 0,
 is_primary BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(variant_id,s3_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS product_variant_images_primary_idx ON product_variant_images(variant_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS product_variant_images_key_idx ON product_variant_images(s3_key);
