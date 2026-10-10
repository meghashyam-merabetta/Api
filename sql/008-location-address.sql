ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS house_number varchar(100) NOT NULL DEFAULT '';
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS building_name varchar(200) NOT NULL DEFAULT '';
ALTER TABLE customer_addresses ADD COLUMN IF NOT EXISTS location jsonb;
