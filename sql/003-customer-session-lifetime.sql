ALTER TABLE customer_login_logs ALTER COLUMN expires_at DROP NOT NULL;
-- Convert only currently valid sessions; never resurrect expired/revoked logins.
UPDATE customer_login_logs
SET expires_at = NULL
WHERE deleted_at IS NULL AND expires_at > now();
