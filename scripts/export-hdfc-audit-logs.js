import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../src/config/database.js';

// Export only bank verification fields; no keys, customer details or payment links.
const fields = ['order_id', 'merchant_id', 'status', 'status_id', 'amount', 'currency', 'txn_id', 'gateway_id', 'gateway', 'test_mode'];
const [orderId, output] = process.argv.slice(2);
if (!/^MB(?:[0-9]{11}|[a-f0-9]{18})$/.test(orderId || '') || !output)
  throw new Error('Usage: node scripts/export-hdfc-audit-logs.js ORDER_ID OUTPUT.json');
try {
  const rows = await sequelize.query("SELECT created_at,endpoint,http_status,provider_status,response_body FROM third_party_api_logs WHERE provider='hdfc' AND endpoint=:endpoint ORDER BY created_at", {
    replacements: { endpoint: '/orders/' + orderId }, type: QueryTypes.SELECT,
  });
  if (!rows.length) throw new Error('No Status API logs found for this order');
  const logs = rows.map(row => {
    let data;
    try { data = JSON.parse(row.response_body || '{}'); } catch { data = {}; }
    return { timestamp: row.created_at, method: 'GET', endpoint: row.endpoint, httpStatus: row.http_status,
      response: Object.fromEntries(fields.filter(key => ['string', 'number', 'boolean'].includes(typeof data[key])).map(key => [key, data[key]])) };
  });
  await writeFile(resolve(output), JSON.stringify({ orderId, redacted: true, note: 'Customer details, credentials and payment links omitted. Original responses retained in restricted database logs.', logs }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`Exported ${logs.length} redacted Status API responses to ${resolve(output)}`);
} finally { await sequelize.close(); }
