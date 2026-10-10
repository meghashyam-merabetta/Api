CREATE TABLE IF NOT EXISTS third_party_api_logs (
  id uuid PRIMARY KEY,
  provider varchar(40) NOT NULL,
  endpoint varchar(250) NOT NULL,
  method varchar(10) NOT NULL,
  outcome varchar(30) NOT NULL,
  http_status integer,
  duration_ms integer,
  provider_status varchar(40),
  validation_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure varchar(60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS third_party_api_logs_created_idx ON third_party_api_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS third_party_api_logs_provider_idx ON third_party_api_logs(provider,created_at DESC);
