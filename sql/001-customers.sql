CREATE TABLE IF NOT EXISTS customers (
 id uuid PRIMARY KEY, first_name varchar(100), last_name varchar(100), phone varchar(10), email varchar(254), date_of_birth date, gender varchar(30),
 profile_completed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 CHECK (phone IS NULL OR phone ~ '^[6-9][0-9]{9}$'), CHECK (date_of_birth IS NULL OR date_of_birth >= DATE '1900-01-01')
);
CREATE TABLE IF NOT EXISTS customer_identities (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), method varchar(5) NOT NULL CHECK(method IN ('phone','email')), contact varchar(254) NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(), UNIQUE(method,contact)
);
CREATE TABLE IF NOT EXISTS customer_otp_challenges (
 id uuid PRIMARY KEY, method varchar(5) NOT NULL CHECK(method IN ('phone','email')), contact varchar(254) NOT NULL, code_hash char(64) NOT NULL,
 attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_otp_contact_idx ON customer_otp_challenges(method,contact,created_at DESC);
CREATE TABLE IF NOT EXISTS customer_login_logs (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), token_hash char(64) NOT NULL UNIQUE,
 login_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, deleted_at timestamptz,
 device_info jsonb, user_agent varchar(512), ip_address varchar(64)
);
CREATE INDEX IF NOT EXISTS customer_login_customer_idx ON customer_login_logs(customer_id);
CREATE TABLE IF NOT EXISTS customer_addresses (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), line1 varchar(200) NOT NULL, line2 varchar(200) NOT NULL DEFAULT '', landmark varchar(200) NOT NULL DEFAULT '',
 state varchar(100) NOT NULL, city varchar(100) NOT NULL, postal_code varchar(6) NOT NULL CHECK(postal_code ~ '^[1-9][0-9]{5}$'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS customer_addresses_owner_idx ON customer_addresses(customer_id);
CREATE TABLE IF NOT EXISTS customer_family_members (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), name varchar(200) NOT NULL, relationship varchar(30) NOT NULL,
 phone varchar(10), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 CHECK (phone IS NULL OR phone ~ '^[6-9][0-9]{9}$'), CHECK(relationship IN ('Self','Mother','Father','Spouse','Grandparent','Other'))
);
CREATE INDEX IF NOT EXISTS customer_family_owner_idx ON customer_family_members(customer_id);
