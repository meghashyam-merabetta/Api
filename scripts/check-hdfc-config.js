import { env } from '../src/config/env.js';
import { requireGateway } from '../src/app/hdfc/client.js';
import { sequelize } from '../src/config/database.js';

// Read-only preflight. Does not print secrets or send a payment to HDFC.
let failed = false;
function check(name, okay) {
  console.log(`${okay ? 'PASS' : 'MISSING/INVALID'}: ${name}`);
  if (!okay) failed = true;
}
for (const name of ['HDFC_MERCHANT_ID', 'HDFC_CLIENT_ID', 'HDFC_RETURN_URL', 'HDFC_JWT_KEY_ID', 'HDFC_JWT_PRIVATE_KEY_PATH', 'HDFC_JWT_BANK_PUBLIC_KEY_PATH', 'HDFC_WEBHOOK_USER', 'HDFC_WEBHOOK_PASSWORD'])
  check(name, Boolean(env[name]));
try { requireGateway(); check('JWT PEM files, RSA key types and return URL', true); }
catch { check('JWT PEM files, RSA key types and return URL', false); }
check('Client ID matches environment', env.HDFC_ENVIRONMENT === 'sandbox'
  ? env.HDFC_CLIENT_ID === 'hdfcmaster'
  : env.HDFC_CLIENT_ID === env.HDFC_MERCHANT_ID && env.HDFC_CLIENT_ID !== 'hdfcmaster');
check('Webhook username is alphanumeric', /^[A-Za-z0-9]+$/.test(env.HDFC_WEBHOOK_USER));
if (process.argv.includes('--database')) {
  try {
    const [rows] = await sequelize.query("SELECT to_regclass('product_checkouts') IS NOT NULL AS checkouts, to_regclass('hdfc_sdk_sessions') IS NOT NULL AS sessions", { logging: false });
    check('Payment database schema', rows[0].checkouts && rows[0].sessions);
  } catch { check('Payment database connection/schema', false); }
}
await sequelize.close();
console.log(`Environment: ${env.HDFC_ENVIRONMENT}. No bank request was sent.`);
process.exitCode = failed ? 1 : 0;
