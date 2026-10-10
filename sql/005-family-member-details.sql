ALTER TABLE customer_family_members
  ADD COLUMN IF NOT EXISTS age integer CHECK (age BETWEEN 0 AND 120),
  ADD COLUMN IF NOT EXISTS gender varchar(30) CHECK (gender IN ('Female', 'Male', 'Other', 'Prefer not to say'));
