CREATE TABLE IF NOT EXISTS product_images (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id BIGINT NOT NULL
        REFERENCES products(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    s3_key TEXT NOT NULL UNIQUE,
    alt_text VARCHAR(255),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_images_product_id
    ON product_images(product_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_images_one_primary
    ON product_images(product_id)
    WHERE is_primary = TRUE;
