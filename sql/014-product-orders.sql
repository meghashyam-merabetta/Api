CREATE TABLE IF NOT EXISTS product_catalog (
 id varchar(100) PRIMARY KEY, data jsonb NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS orders (
 id varchar(20) PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id),
 request_key varchar(100) NOT NULL, fingerprint varchar(64) NOT NULL,
 amount_paise bigint NOT NULL CHECK(amount_paise>0), currency varchar(3) NOT NULL DEFAULT 'INR',
 payment_status varchar(40) NOT NULL DEFAULT 'NEW', session_state varchar(20) NOT NULL DEFAULT 'created',
 payment_url text, payment_expiry timestamptz, payload jsonb NOT NULL,
 transaction_id text, last_error text, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,request_key)
);
CREATE TABLE IF NOT EXISTS order_details (
 order_id varchar(20) NOT NULL REFERENCES orders(id),product_id varchar(100) NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0),unit_price_paise bigint NOT NULL CHECK(unit_price_paise>=0),
 snapshot jsonb NOT NULL,PRIMARY KEY(order_id,product_id)
);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id,created_at DESC);
