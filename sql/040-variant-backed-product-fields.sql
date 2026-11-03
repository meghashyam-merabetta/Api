-- Run only after verified backup and separate schema/data-migration approval.
-- Copy/verify first; all steps including removal are enclosed by the caller transaction.
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(771209);
LOCK TABLE public.products,public.product_variants IN ACCESS EXCLUSIVE MODE;
DO $migration$
DECLARE
 core text[]:=ARRAY['id','brand_id','name','slug','description','short_description','product_status','created_at','updated_at'];
 expected text[]:=ARRAY['product_code','sku','product_type','regular_price','sale_price','offer_percent','special_discount_enabled','special_discount_percent','festival_offer_enabled','festival_offer_percent','stock_quantity','min_order_quantity','max_order_quantity','target_audience','hsn_code','gst_rate','weight','weight_unit','unit_count','package_length','package_breadth','package_height','dimension_unit','material','colour','package_type','shelf_life','water_resistant','hazardous_clause','manufactured_in','company_name','company_address','packer_name','packer_address','keywords','barcode','reusable','has_accessories','accessories','item_condition','product_length','product_breadth','product_height','product_dimension_unit','gift_options_available','gift_options_charge','gift_wrap_available','gift_wrap_charge','manufacturer_sku','brand_type','is_customisable','model_number','manufacturer_contact_name','manufacturer_phone','manufacturer_email','license_number','repacker_name','repacker_address','age_min','age_max','age_unit','audience_age_group','product_uses','special_instructions','material_composition','material_type','resistance_level','heat_resistant','gas_resistant','physical_state','pattern','hazard_classification','net_weight','net_weight_unit','manufacturing_date','fulfillment_channel','seller_handling_days','business_offer_percent','sale_start_date','sale_end_date','shipping_template','seller_pincodes','battery_required','battery_consumption','cosmetic_features','deleted_at','attributes','product_group_code','inventory_managed','created_by','updated_by'];
 fields jsonb; indexes jsonb; checks jsonb; defaults_sql text; projection text; def record;
 manifest jsonb; triggers jsonb; variant_combinations jsonb; variant_indexes jsonb; extras text[]; missing text[]; unknowns text[]; n bigint;
BEGIN
 IF to_regclass('public.product_records') IS NOT NULL THEN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='products')<>9
  THEN RAISE EXCEPTION 'Existing storage view has an unexpected physical products schema'; END IF;
  RETURN;
 END IF;
 IF current_setting('server_version_num')::int < 150000 THEN RAISE EXCEPTION 'PostgreSQL 15+ is required for security-invoker views'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.products'::regclass,'public.product_variants'::regclass) AND relrowsecurity)
 THEN RAISE EXCEPTION 'Review existing RLS policies before relocating product storage'; END IF;
 SELECT array_agg(column_name::text ORDER BY ordinal_position) INTO extras FROM information_schema.columns
 WHERE table_schema='public' AND table_name='products' AND NOT column_name=ANY(core);
 SELECT array_agg(e) INTO missing FROM unnest(expected) e WHERE NOT e=ANY(COALESCE(extras,ARRAY[]::text[]));
 SELECT array_agg(e) INTO unknowns FROM unnest(extras) e WHERE NOT e=ANY(expected||ARRAY['is_configuration_group']);
 IF missing IS NOT NULL OR unknowns IS NOT NULL THEN RAISE EXCEPTION 'Unreviewed product schema. Missing %, unknown %',missing,unknowns; END IF;
 IF EXISTS(SELECT 1 FROM product_variants WHERE attributes ?| ARRAY['__product_fields','__product_store'] OR left(sku,length('__product_fields__:'))='__product_fields__:')
 THEN RAISE EXCEPTION 'Reserved storage attributes/SKU already exist; review conflicts'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.products'::regclass AND NOT tgisinternal AND tgname NOT IN ('catalog_metadata','catalog_audit'))
 THEN RAISE EXCEPTION 'Unreviewed product trigger prevents relocation'; END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=ANY(c.confkey)
 WHERE c.contype='f' AND c.confrelid='public.products'::regclass AND NOT a.attname=ANY(core))
 THEN RAISE EXCEPTION 'Foreign keys reference extension columns; do not drop with CASCADE'; END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
 INTO fields FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid='public.products'::regclass AND a.attnum>0 AND NOT a.attisdropped AND NOT a.attname=ANY(core);
 SELECT COALESCE(jsonb_agg(indexdef),'[]') INTO indexes FROM pg_indexes WHERE schemaname='public' AND tablename='products';
 SELECT COALESCE(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'expression',pg_get_expr(conbin,conrelid),'definition',pg_get_constraintdef(oid))),'[]') INTO checks
 FROM pg_constraint WHERE conrelid='public.products'::regclass;
 SELECT COALESCE(jsonb_agg(pg_get_triggerdef(oid)),'[]') INTO triggers FROM pg_trigger WHERE tgrelid='public.products'::regclass AND NOT tgisinternal;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid))),'[]') INTO variant_combinations
 FROM pg_constraint c WHERE c.conrelid='public.product_variants'::regclass AND c.contype='u'
 AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k ORDER BY a.attname)=ARRAY['attributes','product_id'];
 SELECT COALESCE(jsonb_agg(jsonb_build_object('name',ci.relname,'definition',pg_get_indexdef(i.indexrelid))),'[]') INTO variant_indexes
 FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid='public.product_variants'::regclass AND i.indisunique
 AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid)
 AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) k JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k ORDER BY a.attname)=ARRAY['attributes','product_id'];
 manifest:=jsonb_build_object('version',1,'core',core,'fields',fields,'indexes',indexes,'constraints',checks,'triggers',triggers,'variant_combinations',variant_combinations,'variant_indexes',variant_indexes);
 EXECUTE format('CREATE OR REPLACE FUNCTION public.product_field_storage_manifest() RETURNS jsonb LANGUAGE sql IMMUTABLE AS %L', 'SELECT '||quote_literal(manifest::text)||'::jsonb');
 SELECT string_agg(format('(%L, to_jsonb((%s)::%s))',value->>'name',COALESCE(value->>'default','NULL'),value->>'type'),',')
 INTO defaults_sql FROM jsonb_array_elements(fields);
 IF NOT 'is_configuration_group'=ANY(extras) THEN defaults_sql:=defaults_sql||',(''is_configuration_group'',to_jsonb(false))'; END IF;
 EXECUTE format('CREATE OR REPLACE FUNCTION public.product_field_defaults() RETURNS jsonb LANGUAGE sql STABLE AS %L','SELECT jsonb_object_agg(k,v) FROM (VALUES '||defaults_sql||') AS d(k,v)');
 -- Full JSON metadata must not enter the existing variant-combination btree (index row size limit).
 FOR def IN SELECT value FROM jsonb_array_elements(variant_combinations) LOOP
  EXECUTE format('ALTER TABLE public.product_variants DROP CONSTRAINT %I',def.value->>'name');
 END LOOP;
 FOR def IN SELECT value FROM jsonb_array_elements(variant_indexes) LOOP
  EXECUTE format('DROP INDEX public.%I',def.value->>'name');
 END LOOP;
 CREATE UNIQUE INDEX variant_configuration_attributes_unique ON public.product_variants(product_id,attributes) WHERE NOT attributes @> '{"__product_store":true}';
 -- One hidden, inactive storage row per product: no duplication across every size.
 INSERT INTO public.product_variants(product_id,sku,attributes,is_active)
 SELECT p.id,'__product_fields__:'||p.id,jsonb_build_object('__product_store',true,'__product_fields',
   (to_jsonb(p)-core)||CASE WHEN 'is_configuration_group'=ANY(extras) THEN '{}'::jsonb ELSE '{"is_configuration_group":false}'::jsonb END),false
 FROM public.products p;
 CREATE UNIQUE INDEX product_field_store_owner ON public.product_variants(product_id) WHERE attributes @> '{"__product_store":true}';
 SELECT string_agg(format('((s.attributes->''__product_fields'')->>%L)::%s AS %I',value->>'name',value->>'type',value->>'name'),',')
 INTO projection FROM jsonb_array_elements(fields);
 -- JSONB extraction preserves JSON arrays/objects/nulls rather than turning them into text.
 FOR def IN SELECT value FROM jsonb_array_elements(fields) WHERE value->>'type'='jsonb' LOOP
  projection:=replace(projection,format('((s.attributes->''__product_fields'')->>%L)::jsonb AS %I',def.value->>'name',def.value->>'name'),
   format('(s.attributes->''__product_fields'')->%L AS %I',def.value->>'name',def.value->>'name'));
 END LOOP;
 IF NOT 'is_configuration_group'=ANY(extras) THEN projection:=projection||',COALESCE((s.attributes#>>''{__product_fields,is_configuration_group}'')::boolean,false) AS is_configuration_group'; END IF;
 EXECUTE 'CREATE VIEW public.product_records WITH (security_invoker=true) AS SELECT p.id,p.brand_id,p.name,p.slug,p.description,p.short_description,p.product_status,p.created_at,p.updated_at,'||projection||
  ' FROM public.products p JOIN public.product_variants s ON s.product_id=p.id AND s.attributes @> ''{"__product_store":true}''';
 FOR def IN SELECT value FROM jsonb_array_elements(fields) WHERE value->>'default' IS NOT NULL LOOP
  EXECUTE format('ALTER VIEW public.product_records ALTER COLUMN %I SET DEFAULT %s',def.value->>'name',def.value->>'default');
 END LOOP;
 FOR def IN SELECT a.attname,pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a
  JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.products'::regclass AND a.attname=ANY(core) LOOP
  EXECUTE format('ALTER VIEW public.product_records ALTER COLUMN %I SET DEFAULT %s',def.attname,def.expression);
 END LOOP;
 ALTER VIEW public.product_records ALTER COLUMN is_configuration_group SET DEFAULT false;
 SELECT count(*) INTO n FROM public.products p JOIN public.product_records v ON v.id=p.id
 WHERE to_jsonb(p) IS DISTINCT FROM CASE WHEN 'is_configuration_group'=ANY(extras) THEN to_jsonb(v) ELSE to_jsonb(v)-'is_configuration_group' END;
 IF n<>0 OR (SELECT count(*) FROM public.products)<>(SELECT count(*) FROM public.product_records)
 THEN RAISE EXCEPTION 'Product field copy verification failed for % records; transaction rolls back',n; END IF;
 DROP TRIGGER IF EXISTS catalog_metadata ON public.products;
 DROP TRIGGER IF EXISTS catalog_audit ON public.products;
 -- No CASCADE: dependent views/constraints not covered by review must fail closed.
 FOREACH defaults_sql IN ARRAY extras LOOP EXECUTE format('ALTER TABLE public.products DROP COLUMN %I',defaults_sql); END LOOP;
 CREATE VIEW public.product_variant_records WITH (security_invoker=true) AS
  SELECT * FROM public.product_variants WHERE NOT attributes @> '{"__product_store":true}' WITH LOCAL CHECK OPTION;
 CREATE UNIQUE INDEX product_field_sku_unique ON public.product_variants((attributes#>>'{__product_fields,sku}'))
  WHERE attributes @> '{"__product_store":true}' AND attributes#>>'{__product_fields,sku}' IS NOT NULL;
 CREATE UNIQUE INDEX product_field_code_unique ON public.product_variants((attributes#>>'{__product_fields,product_code}'))
  WHERE attributes @> '{"__product_store":true}' AND attributes#>>'{__product_fields,product_code}' IS NOT NULL;
 CREATE INDEX product_field_creator_idx ON public.product_variants((attributes#>>'{__product_fields,created_by}')) WHERE attributes @> '{"__product_store":true}';
 CREATE INDEX product_field_updater_idx ON public.product_variants((attributes#>>'{__product_fields,updated_by}')) WHERE attributes @> '{"__product_store":true}';
END $migration$;

CREATE OR REPLACE FUNCTION public.create_product_field_store() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_write text:=current_setting('catalog.product_field_write',true);
BEGIN
 PERFORM set_config('catalog.product_field_write','true',true);
 INSERT INTO public.product_variants(product_id,sku,attributes,is_active)
 VALUES(NEW.id,'__product_fields__:'||NEW.id,jsonb_build_object('__product_store',true,'__product_fields',public.product_field_defaults()),false);
 PERFORM set_config('catalog.product_field_write',COALESCE(previous_write,''),true);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS create_product_field_store ON public.products;
CREATE TRIGGER create_product_field_store AFTER INSERT ON public.products FOR EACH ROW EXECUTE FUNCTION public.create_product_field_store();

CREATE OR REPLACE FUNCTION public.write_product_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 core text[]:=ARRAY['id','brand_id','name','slug','description','short_description','product_status','created_at','updated_at'];
 payload jsonb; before_row jsonb; after_row jsonb; changed text[]; field record; is_missing boolean; check_ok boolean; previous_write text; actor uuid:=NULLIF(current_setting('catalog.actor',true),'')::uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Products must be archived; physical deletion requires reviewed recovery'; END IF;
 IF TG_OP='UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Product identity is immutable'; END IF;
 payload:=to_jsonb(NEW)-core;
 IF TG_OP='INSERT' THEN
  NEW.created_at:=COALESCE(NEW.created_at,clock_timestamp()); NEW.updated_at:=clock_timestamp();
  payload:=jsonb_set(payload,'{created_by}',COALESCE(to_jsonb(actor),'null'::jsonb));
 ELSE
  NEW.created_at:=OLD.created_at; NEW.updated_at:=clock_timestamp();
  payload:=jsonb_set(payload,'{created_by}',COALESCE(to_jsonb(OLD.created_by),'null'::jsonb));
  before_row:=to_jsonb(OLD);
 END IF;
 payload:=jsonb_set(payload,'{updated_by}',COALESCE(to_jsonb(actor),'null'::jsonb));
 FOR field IN SELECT value FROM jsonb_array_elements(public.product_field_storage_manifest()->'fields') WHERE (value->>'not_null')::boolean LOOP
  EXECUTE format('SELECT ($1).%I IS NULL',field.value->>'name') INTO is_missing USING NEW;
  IF is_missing THEN RAISE EXCEPTION 'Product field % cannot be null',field.value->>'name' USING ERRCODE='23502'; END IF;
 END LOOP;
 FOR field IN SELECT value FROM jsonb_array_elements(public.product_field_storage_manifest()->'constraints') WHERE value->>'type'='c' LOOP
  EXECUTE 'SELECT ('||(field.value->>'expression')||') FROM (SELECT ($1).*) AS checked_product' INTO check_ok USING NEW;
  IF check_ok IS FALSE THEN RAISE EXCEPTION 'Product check % violated',field.value->>'name' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor) THEN RAISE EXCEPTION 'Unknown product actor' USING ERRCODE='23503'; END IF;
 previous_write:=current_setting('catalog.product_field_write',true);
 PERFORM set_config('catalog.product_field_write','true',true);
 IF (payload->>'stock_quantity')::int<0 OR (payload->>'regular_price')::numeric<0
  OR (payload->>'sale_price')::numeric<0 OR ((payload->>'sale_price') IS NOT NULL AND
    ((payload->>'regular_price') IS NULL OR (payload->>'sale_price')::numeric>(payload->>'regular_price')::numeric))
 THEN RAISE EXCEPTION 'Invalid product price or stock' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.id IS NULL THEN
   INSERT INTO public.products(brand_id,name,slug,description,short_description,product_status,created_at,updated_at)
   VALUES(NEW.brand_id,NEW.name,NEW.slug,NEW.description,NEW.short_description,NEW.product_status,NEW.created_at,NEW.updated_at) RETURNING id INTO NEW.id;
  ELSE
   INSERT INTO public.products(id,brand_id,name,slug,description,short_description,product_status,created_at,updated_at)
   VALUES(NEW.id,NEW.brand_id,NEW.name,NEW.slug,NEW.description,NEW.short_description,NEW.product_status,NEW.created_at,NEW.updated_at);
  END IF;
 ELSE
  UPDATE public.products SET brand_id=NEW.brand_id,name=NEW.name,slug=NEW.slug,description=NEW.description,short_description=NEW.short_description,
   product_status=NEW.product_status,updated_at=NEW.updated_at WHERE id=OLD.id;
 END IF;
 UPDATE public.product_variants SET attributes=jsonb_set(attributes,'{__product_fields}',payload),updated_at=clock_timestamp()
 WHERE product_id=NEW.id AND attributes @> '{"__product_store":true}';
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing product attribute storage row'; END IF;
 PERFORM set_config('catalog.product_field_write',COALESCE(previous_write,''),true);
 NEW:=jsonb_populate_record(NEW,payload);
 after_row:=to_jsonb(NEW);
 SELECT array_agg(key ORDER BY key) INTO changed FROM jsonb_object_keys(COALESCE(before_row,'{}')||after_row) key
 WHERE key NOT IN ('created_at','updated_at','created_by','updated_by') AND before_row->key IS DISTINCT FROM after_row->key;
 IF changed IS NOT NULL THEN
  INSERT INTO public.audit_logs(entity_type,entity_id,action,old_values,new_values,changed_fields,changed_by,actor_type,request_id,reason)
  VALUES('product',NEW.id::text,lower(TG_OP),before_row,after_row,changed,actor,
   COALESCE(NULLIF(current_setting('catalog.actor_type',true),''),'system'),NULLIF(current_setting('catalog.request_id',true),''),NULLIF(current_setting('catalog.reason',true),''));
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS write_product_record ON public.product_records;
CREATE TRIGGER write_product_record INSTEAD OF INSERT OR UPDATE OR DELETE ON public.product_records FOR EACH ROW EXECUTE FUNCTION public.write_product_record();

CREATE OR REPLACE FUNCTION public.protect_product_field_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.product_variants WHERE attributes @> '{"__product_store":true}' AND
   (attributes#>>'{__product_fields,created_by}'=OLD.id::text OR attributes#>>'{__product_fields,updated_by}'=OLD.id::text))
 THEN RAISE EXCEPTION 'Admin is referenced by product provenance; deactivate instead' USING ERRCODE='23503'; END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS protect_product_field_actor ON public.users;
CREATE TRIGGER protect_product_field_actor BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.protect_product_field_actor();

CREATE OR REPLACE FUNCTION public.protect_product_field_store() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.attributes @> '{"__product_store":true}' THEN
  IF TG_OP='DELETE' OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.sku IS DISTINCT FROM OLD.sku OR NEW.is_active
  THEN RAISE EXCEPTION 'Product attribute storage identity must be retained'; END IF;
 END IF;
 IF (TG_OP<>'DELETE' AND NEW.attributes ?| ARRAY['__product_fields','__product_store']) OR (TG_OP<>'INSERT' AND OLD.attributes @> '{"__product_store":true}') THEN
  IF current_setting('catalog.product_field_write',true) IS DISTINCT FROM 'true'
  THEN RAISE EXCEPTION 'Edit product fields through product_records; reserved storage attributes are protected'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS protect_product_field_store ON public.product_variants;
CREATE TRIGGER protect_product_field_store BEFORE INSERT OR UPDATE OR DELETE ON public.product_variants FOR EACH ROW EXECUTE FUNCTION public.protect_product_field_store();
