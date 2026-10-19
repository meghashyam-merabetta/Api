CREATE TABLE IF NOT EXISTS customer_email_verifications (
 id uuid PRIMARY KEY,
 customer_id uuid NOT NULL REFERENCES customers(id),
 email varchar(254) NOT NULL,
 code_hash char(64) NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_email_verifications_customer_idx ON customer_email_verifications(customer_id,created_at DESC);
