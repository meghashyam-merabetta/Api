CREATE TABLE IF NOT EXISTS lab_catalog_sync (
  lab_id varchar(100) PRIMARY KEY REFERENCES labs(id),
  status varchar(20) NOT NULL DEFAULT 'idle',
  next_page integer NOT NULL DEFAULT 1,
  pages_done integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  retry_at timestamptz,
  error varchar(500)
);
INSERT INTO lab_catalog_sync(lab_id) SELECT id FROM labs WHERE id='redcliffe'
ON CONFLICT DO NOTHING;
