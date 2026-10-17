CREATE TABLE IF NOT EXISTS contact_enquiries (
  id uuid PRIMARY KEY, name varchar(120) NOT NULL, email varchar(254) NOT NULL,
  phone varchar(20) NOT NULL, message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  notification_sent_at timestamptz, notification_attempts integer NOT NULL DEFAULT 0,
  notification_retry_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_enquiries_pending_idx ON contact_enquiries(notification_retry_at,created_at)
  WHERE notification_sent_at IS NULL;
CREATE TABLE IF NOT EXISTS coupons (
  code varchar(40) PRIMARY KEY CHECK (code = upper(code)),
  scope varchar(10) NOT NULL CHECK (scope IN ('labs','products','both')),
  percent numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  max_discount_paise integer NOT NULL CHECK (max_discount_paise > 0),
  active boolean NOT NULL DEFAULT false,
  starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
