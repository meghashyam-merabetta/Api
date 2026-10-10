CREATE TABLE IF NOT EXISTS lab_packages (
  id varchar(100) PRIMARY KEY,
  lab_id varchar(100) NOT NULL REFERENCES labs(id),
  package_code varchar(100) NOT NULL,
  catalog_data jsonb NOT NULL,
  provider_data jsonb NOT NULL,
  parameter_data jsonb,
  active boolean NOT NULL DEFAULT true,
  synced_at timestamptz NOT NULL DEFAULT now(),
  parameters_synced_at timestamptz,
  UNIQUE(lab_id, package_code)
);
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS lab_id varchar(100) REFERENCES labs(id);
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES customer_family_members(id);
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS provider_booking_id varchar(100);
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS integration_status varchar(40) NOT NULL DEFAULT 'legacy';
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS request_fingerprint varchar(64);
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS provider_request jsonb;
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS provider_response jsonb;
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS confirmation_response jsonb;
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS last_error varchar(500);
ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS lab_bookings_provider_id ON lab_bookings(lab_id, provider_booking_id) WHERE provider_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lab_packages_active ON lab_packages(lab_id, active);
