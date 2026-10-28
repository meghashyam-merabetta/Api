-- 7 Product Specification & Option Fixes + 37 AdditionalProductDetails Columns:
-- 1. Product-level EAN / Barcode in Specifications
-- 2. Product Usage Status: Disposable / Reusable (reusable BOOLEAN: false = Disposable, true = Reusable)
-- 3. Accessories Along With Product (has_accessories BOOLEAN + accessories TEXT)
-- 4. Condition of Item (item_condition: 'new' | 'refurbished')
-- 5. Individual Item Length & Breadth Inside Package (product_length, product_breadth, product_height, product_dimension_unit)
-- 6. Gift Options Availability & Charge (gift_options_available BOOLEAN + gift_options_charge NUMERIC(12, 2))
-- 7. Gift Wrap Availability & Charge (gift_wrap_available BOOLEAN + gift_wrap_charge NUMERIC(12, 2))
-- + 37 Additional Product Details fields from CMS AdditionalProductDetails

ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS reusable BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS has_accessories BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS accessories TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS item_condition VARCHAR(20) NOT NULL DEFAULT 'new';
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_length NUMERIC(15, 3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_breadth NUMERIC(15, 3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_height NUMERIC(15, 3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_dimension_unit TEXT DEFAULT 'cm';
ALTER TABLE products ADD COLUMN IF NOT EXISTS gift_options_available BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS gift_options_charge NUMERIC(12, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS gift_wrap_available BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS gift_wrap_charge NUMERIC(12, 2);

-- 37 AdditionalProductDetails columns
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer_sku TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_type TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_customisable BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_number TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer_contact_name TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer_phone TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer_email TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS license_number TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS repacker_name TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS repacker_address TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS age_min INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS age_max INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS age_unit TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS audience_age_group TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_uses TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS special_instructions TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS material_composition TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS material_type TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS resistance_level TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS heat_resistant BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS gas_resistant BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS physical_state TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS pattern TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS hazard_classification TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS net_weight NUMERIC(15, 3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS net_weight_unit TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturing_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS fulfillment_channel TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_handling_days INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS business_offer_percent NUMERIC(15, 3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_start_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_end_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_template TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS seller_pincodes JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS battery_required BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS battery_consumption TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cosmetic_features TEXT;

-- Backfill has_accessories = true for any existing rows that already have non-empty accessories text
UPDATE products
SET has_accessories = true
WHERE accessories IS NOT NULL AND btrim(accessories) <> '' AND has_accessories = false;
