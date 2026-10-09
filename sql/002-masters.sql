CREATE TABLE IF NOT EXISTS master_states (
  id uuid PRIMARY KEY,
  name varchar(100) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS master_cities (
  id uuid PRIMARY KEY,
  state_id uuid NOT NULL REFERENCES master_states(id),
  name varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state_id, name)
);

CREATE TABLE IF NOT EXISTS faqs (
  id uuid PRIMARY KEY,
  question text NOT NULL UNIQUE,
  answer text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
