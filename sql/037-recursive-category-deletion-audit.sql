-- Apply separately after 036-independent-products-audit.sql and 036-product-soft-delete.sql.
-- Schema only; does not delete categories, products, inventory, or history.
CREATE OR REPLACE FUNCTION catalog_category_delete_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE summary JSONB := NULLIF(current_setting('catalog.category_delete_summary',true),'')::jsonb;
BEGIN
 IF summary->>'deleted_category_id' IS DISTINCT FROM OLD.id::text THEN
  summary := jsonb_build_object('deleted_category_id',OLD.id::text,'deleted_category_name',OLD.name,
    'previous_parent_id',OLD.parent_id,'counts_verified',false);
 END IF;
 summary := summary || jsonb_build_object('deleted_by',NULLIF(current_setting('catalog.actor',true),''),
   'deleted_at',transaction_timestamp());
 INSERT INTO audit_logs(entity_type,entity_id,action,old_values,new_values,changed_fields,changed_by,actor_type,request_id,reason)
 VALUES('category',OLD.id::text,'CATEGORY_DELETED',to_jsonb(OLD),summary,ARRAY['deleted'],
   NULLIF(current_setting('catalog.actor',true),'')::uuid,
   COALESCE(NULLIF(current_setting('catalog.actor_type',true),''),'system'),
   NULLIF(current_setting('catalog.request_id',true),''),NULLIF(current_setting('catalog.reason',true),''));
 RETURN NULL;
END $$;
-- Exactly one logical deletion event; generic insert/update auditing remains intact.
DROP TRIGGER IF EXISTS catalog_audit ON categories;
CREATE TRIGGER catalog_audit AFTER INSERT OR UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION catalog_audit_row('category');
DROP TRIGGER IF EXISTS catalog_category_delete_audit ON categories;
CREATE TRIGGER catalog_category_delete_audit AFTER DELETE ON categories FOR EACH ROW EXECUTE FUNCTION catalog_category_delete_audit();
