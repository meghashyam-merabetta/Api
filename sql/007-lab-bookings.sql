CREATE TABLE IF NOT EXISTS lab_service_areas (
 id uuid PRIMARY KEY, name varchar(200) NOT NULL, city varchar(100) NOT NULL, state varchar(100) NOT NULL,
 postal_code varchar(6) NOT NULL CHECK (postal_code ~ '^[1-9][0-9]{5}$'), lab_ids jsonb NOT NULL DEFAULT '[]',
 active boolean NOT NULL DEFAULT true, UNIQUE(name, city, state, postal_code)
);
CREATE TABLE IF NOT EXISTS lab_bookings (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), request_key varchar(100) NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id, request_key)
);
