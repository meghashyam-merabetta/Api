-- Admin Management
-- Identity/password data stays in users; admin-specific data lives in admin_profiles.
-- This migration intentionally does not duplicate password storage.

CREATE TABLE IF NOT EXISTS admin_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  city varchar(100),
  pincode varchar(6),
  state varchar(100),
  require_super_admin_approval boolean NOT NULL DEFAULT false,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
  CHECK (jsonb_typeof(permissions) = 'array')
);

CREATE INDEX IF NOT EXISTS admin_profiles_user_idx
  ON admin_profiles(user_id);

CREATE INDEX IF NOT EXISTS admin_profiles_permissions_idx
  ON admin_profiles USING gin(permissions);

-- Backfill profiles for existing admin identities so the new management API
-- can read them without changing their existing credentials.
INSERT INTO admin_profiles (id, user_id, permissions)
SELECT gen_random_uuid(), u.id, '[]'::jsonb
FROM users u
WHERE u.realm = 'admin'
  AND NOT EXISTS (
    SELECT 1
    FROM admin_profiles p
    WHERE p.user_id = u.id
  );
