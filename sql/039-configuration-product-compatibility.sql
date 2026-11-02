-- Schema only. Existing-data conversion and activation are separately approved.
DO $$ BEGIN
 IF to_regclass('public.inventory') IS NULL OR to_regclass('public.audit_logs') IS NULL
 OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='inventory_managed')
 THEN RAISE EXCEPTION 'Independent inventory/audit prerequisite schema 036 is required'; END IF;
END $$;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_configuration_group BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS product_configuration_links (
 variant_id BIGINT PRIMARY KEY REFERENCES product_variants(id),
 product_id BIGINT NOT NULL UNIQUE REFERENCES products(id),
 group_product_id BIGINT NOT NULL REFERENCES products(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(product_id <> group_product_id)
);
CREATE INDEX IF NOT EXISTS configuration_group_idx ON product_configuration_links(group_product_id);
-- A link is identity, not an editable product/stock ownership relationship.
CREATE OR REPLACE FUNCTION configuration_link_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Configuration identity links are immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM product_variants WHERE id=NEW.variant_id AND product_id=NEW.group_product_id)
 THEN RAISE EXCEPTION 'Variant does not belong to the configuration group'; END IF;
 IF EXISTS(SELECT 1 FROM product_configuration_links WHERE group_product_id=NEW.product_id)
 OR EXISTS(SELECT 1 FROM product_configuration_links WHERE product_id=NEW.group_product_id)
 THEN RAISE EXCEPTION 'Configuration groups cannot be nested'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS configuration_identity ON product_configuration_links;
CREATE TRIGGER configuration_identity BEFORE INSERT OR UPDATE OR DELETE ON product_configuration_links
 FOR EACH ROW EXECUTE FUNCTION configuration_link_identity();
