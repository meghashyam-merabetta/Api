// Safe placeholders for unit tests that import the validated application config.
// They are used only by the npm test command and do not connect to a real database.
process.env.NODE_ENV ??= 'test';
if (process.env.NODE_ENV === 'test') {
  process.env.DB_HOST ??= '127.0.0.1';
  process.env.DB_NAME ??= 'test_database';
  process.env.DB_USER ??= 'test_user';
  process.env.DB_PASSWORD ??= 'test_password';
  process.env.APP_JWT_SECRET ??= 'test-only-app-jwt-secret-not-for-production-0001';
  process.env.ADMIN_JWT_SECRET ??= 'test-only-admin-jwt-secret-not-for-production-0002';
  process.env.ALLOWED_ORIGINS ??= 'http://localhost:5173';
}
