-- Additional catalog columns from earlier corrections are intentionally retained.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS variant_name VARCHAR(200);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS barcode VARCHAR(100);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS weight_grams INTEGER;

CREATE TABLE IF NOT EXISTS product_order_counters (
 order_day DATE PRIMARY KEY,
 last_number INTEGER NOT NULL CHECK (last_number BETWEEN 1 AND 99999)
);
CREATE TABLE IF NOT EXISTS product_checkouts (
 id VARCHAR(20) PRIMARY KEY,
 customer_id UUID NOT NULL REFERENCES customers(id),
 request_key VARCHAR(100) NOT NULL,
 fingerprint VARCHAR(64) NOT NULL,
 amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
 currency VARCHAR(3) NOT NULL DEFAULT 'INR',
 payment_status VARCHAR(40) NOT NULL DEFAULT 'NEW',
 session_state VARCHAR(20) NOT NULL DEFAULT 'created',
 payment_url TEXT, payment_expiry TIMESTAMPTZ,
 payload JSONB NOT NULL, transaction_id TEXT, last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 stock_state VARCHAR(20) NOT NULL DEFAULT 'legacy',
 payment_checked_at TIMESTAMPTZ, order_number VARCHAR(13),
 UNIQUE(customer_id, request_key)
);
ALTER TABLE product_checkouts ADD COLUMN IF NOT EXISTS stock_state VARCHAR(20) NOT NULL DEFAULT 'legacy';
ALTER TABLE product_checkouts ADD COLUMN IF NOT EXISTS payment_checked_at TIMESTAMPTZ;
ALTER TABLE product_checkouts ADD COLUMN IF NOT EXISTS order_number VARCHAR(13);
CREATE INDEX IF NOT EXISTS product_checkouts_customer_created_idx ON product_checkouts(customer_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS product_checkouts_order_number_unique ON product_checkouts(order_number) WHERE order_number IS NOT NULL;

-- Copy historical orders once. Keep orders/order_details untouched for rollback.
-- Conflicting IDs or request keys fail the migration instead of losing history.
DO $$
BEGIN
 IF to_regclass('orders') IS NOT NULL THEN
  IF EXISTS (
   SELECT 1 FROM orders o JOIN product_checkouts c ON c.id=o.id
   WHERE c.customer_id IS DISTINCT FROM o.customer_id OR c.request_key IS DISTINCT FROM o.request_key
      OR c.fingerprint IS DISTINCT FROM o.fingerprint OR c.amount_paise IS DISTINCT FROM o.amount_paise
  ) THEN RAISE EXCEPTION 'Conflicting orders and product_checkouts IDs; reconcile before migrating'; END IF;
  INSERT INTO product_checkouts (
   id,customer_id,request_key,fingerprint,amount_paise,currency,payment_status,
   session_state,payment_url,payment_expiry,payload,transaction_id,last_error,
   created_at,updated_at,stock_state,payment_checked_at,order_number
  )
  SELECT o.id,o.customer_id,o.request_key,o.fingerprint,o.amount_paise,o.currency,o.payment_status,
   o.session_state,o.payment_url,o.payment_expiry,o.payload,o.transaction_id,o.last_error,
   o.created_at,o.updated_at,COALESCE(to_jsonb(o)->>'stock_state','legacy'),
   (to_jsonb(o)->>'payment_checked_at')::timestamptz,to_jsonb(o)->>'order_number'
  FROM orders o WHERE NOT EXISTS(SELECT 1 FROM product_checkouts c WHERE c.id=o.id);
 END IF;
END $$;

-- Continue any existing MBYYMMDDnnnnn sequence without recycling numbers.
INSERT INTO product_order_counters(order_day,last_number)
SELECT to_date(substring(order_number FROM 3 FOR 6),'YYMMDD'),
       max(substring(order_number FROM 9 FOR 5)::integer)
FROM product_checkouts
WHERE order_number ~ '^MB[0-9]{11}$' AND substring(order_number FROM 9 FOR 5)::integer > 0
GROUP BY substring(order_number FROM 3 FOR 6)
ON CONFLICT(order_day) DO UPDATE SET last_number=GREATEST(product_order_counters.last_number,EXCLUDED.last_number);
