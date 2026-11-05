-- Additive migration: existing product and warehouse rows are preserved.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS manufacturer_sku TEXT,
  ADD COLUMN IF NOT EXISTS brand_type TEXT,
  ADD COLUMN IF NOT EXISTS is_customisable BOOLEAN,
  ADD COLUMN IF NOT EXISTS model_number TEXT,
  ADD COLUMN IF NOT EXISTS manufacturer_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS manufacturer_phone TEXT,
  ADD COLUMN IF NOT EXISTS manufacturer_email TEXT,
  ADD COLUMN IF NOT EXISTS license_number TEXT,
  ADD COLUMN IF NOT EXISTS repacker_name TEXT,
  ADD COLUMN IF NOT EXISTS repacker_address TEXT,
  ADD COLUMN IF NOT EXISTS age_min INTEGER,
  ADD COLUMN IF NOT EXISTS age_max INTEGER,
  ADD COLUMN IF NOT EXISTS age_unit TEXT,
  ADD COLUMN IF NOT EXISTS audience_age_group TEXT,
  ADD COLUMN IF NOT EXISTS product_uses TEXT,
  ADD COLUMN IF NOT EXISTS special_instructions TEXT,
  ADD COLUMN IF NOT EXISTS material_composition TEXT,
  ADD COLUMN IF NOT EXISTS material_type TEXT,
  ADD COLUMN IF NOT EXISTS resistance_level TEXT,
  ADD COLUMN IF NOT EXISTS heat_resistant BOOLEAN,
  ADD COLUMN IF NOT EXISTS gas_resistant BOOLEAN,
  ADD COLUMN IF NOT EXISTS physical_state TEXT,
  ADD COLUMN IF NOT EXISTS pattern TEXT,
  ADD COLUMN IF NOT EXISTS reusable BOOLEAN,
  ADD COLUMN IF NOT EXISTS hazard_classification TEXT,
  ADD COLUMN IF NOT EXISTS net_weight DECIMAL(15,3),
  ADD COLUMN IF NOT EXISTS net_weight_unit TEXT,
  ADD COLUMN IF NOT EXISTS product_length DECIMAL(15,3),
  ADD COLUMN IF NOT EXISTS product_breadth DECIMAL(15,3),
  ADD COLUMN IF NOT EXISTS product_height DECIMAL(15,3),
  ADD COLUMN IF NOT EXISTS product_dimension_unit TEXT,
  ADD COLUMN IF NOT EXISTS manufacturing_date DATE,
  ADD COLUMN IF NOT EXISTS fulfillment_channel TEXT,
  ADD COLUMN IF NOT EXISTS seller_handling_days INTEGER,
  ADD COLUMN IF NOT EXISTS business_offer_percent DECIMAL(15,3),
  ADD COLUMN IF NOT EXISTS sale_start_date DATE,
  ADD COLUMN IF NOT EXISTS sale_end_date DATE,
  ADD COLUMN IF NOT EXISTS shipping_template TEXT,
  ADD COLUMN IF NOT EXISTS seller_pincodes JSONB,
  ADD COLUMN IF NOT EXISTS accessories TEXT,
  ADD COLUMN IF NOT EXISTS battery_required BOOLEAN,
  ADD COLUMN IF NOT EXISTS battery_consumption TEXT,
  ADD COLUMN IF NOT EXISTS cosmetic_features TEXT;

ALTER TABLE product_image_cleanup
  ADD COLUMN IF NOT EXISTS storage_scope TEXT NOT NULL DEFAULT 's3:prod-merabetta';
CREATE INDEX IF NOT EXISTS product_image_cleanup_scope_due
  ON product_image_cleanup(storage_scope, not_before);

-- Matches the existing warehouse contract when bootstrapping an empty test DB.
CREATE TABLE IF NOT EXISTS warehouses (
  warehouse_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_name VARCHAR(150) NOT NULL CHECK (trim(warehouse_name) <> ''),
  address VARCHAR(255) NOT NULL CHECK (trim(address) <> ''),
  city VARCHAR(100) NOT NULL CHECK (trim(city) <> ''),
  state VARCHAR(100) NOT NULL CHECK (trim(state) <> ''),
  pincode VARCHAR(6) NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
  landmark VARCHAR(150),
  contact_name VARCHAR(100) NOT NULL CHECK (trim(contact_name) <> ''),
  contact_phone VARCHAR(10) NOT NULL CHECK (contact_phone ~ '^[6-9][0-9]{9}$'),
  contact_email VARCHAR(150) NOT NULL CHECK (contact_email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
  gstin VARCHAR(15) NOT NULL CHECK (upper(gstin) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
);
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS carrier_ready BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
