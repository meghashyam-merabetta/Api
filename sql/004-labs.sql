CREATE TABLE IF NOT EXISTS labs (
  id varchar(100) PRIMARY KEY,
  name varchar(200) NOT NULL,
  description text NOT NULL,
  rating numeric(2,1) NOT NULL CHECK (rating BETWEEN 0 AND 5),
  image varchar(500) NOT NULL,
  color varchar(7) NOT NULL,
  bg varchar(7) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  city varchar(100) NOT NULL,
  home_collection boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS labs_listing_idx ON labs(active, city, name);
