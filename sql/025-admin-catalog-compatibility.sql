-- Match the original brands schema while preserving deployments using image_url.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'brands' AND column_name = 'logo_url')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'brands' AND column_name = 'image_url') THEN
    ALTER TABLE brands RENAME COLUMN image_url TO logo_url;
  END IF;
END $$;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Existing installations may already have the core variant table.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS regular_price NUMERIC(12,2);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,2);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS stock_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
