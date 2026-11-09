import { randomUUID, timingSafeEqual } from 'node:crypto';
import { recordProviderCall } from '../../shared/provider-log.js';
import { safeGatewayRequest } from './diagnostic-log.js';
import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import { findOrder, syncOrder } from '../orders/orders.controller.js';
import { verifyReturnToken } from './return-token.js';
import { receiptHtml } from './receipt.js';
export async function paymentWebhook(req, res) {
  if (!env.HDFC_WEBHOOK_USER || !env.HDFC_WEBHOOK_PASSWORD)
    throw new HttpError(503, 'Webhook is not configured');
  const expected = Buffer.from(
    'Basic ' +
      Buffer.from(env.HDFC_WEBHOOK_USER + ':' + env.HDFC_WEBHOOK_PASSWORD).toString(
        'base64',
      ),
  );
  const actual = Buffer.from(req.get('authorization') || '');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new HttpError(401, 'Invalid webhook credentials');
  const rawId = req.body?.content?.order?.order_id || req.body?.content?.txn?.order_id;
  const id = typeof rawId === 'string' && /^MB(?:[0-9]{11}|[a-f0-9]{18})$/.test(rawId) ? rawId : null;
  const log = { provider: 'hdfc', providerRequestId: randomUUID(), endpoint: '/webhook', method: 'POST' };
  const start = Date.now();
  const request = safeGatewayRequest(req.body);
  let result = 'ignored_invalid_order';
  try {
    if (id) {
      let row;
      try { row = await findOrder(id); }
      catch (error) { if (error.status !== 404) throw error; }
      if (row) { await syncOrder(row); result = 'verified'; }
      else result = 'ignored_unknown_order';
    }
    await recordProviderCall({ ...log, httpStatus: 200, durationMs: Date.now() - start, responseBody: JSON.stringify({ order_id: id, request, result, response: { received: true } }) });
    return res.status(200).json({ received: true });
  } catch (error) {
    await recordProviderCall({ ...log, httpStatus: Number.isInteger(error.status) ? error.status : 500, durationMs: Date.now() - start, failure: 'webhook_verification_error', responseBody: JSON.stringify({ order_id: id, request, result: 'verification_deferred' }) });
    throw error;
  }
}
export async function paymentReturn(req, res) {
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (!req.params.token) return res.status(400).type('html').send('<h1>Open your order in Merabetta</h1><p>This payment link does not contain an order reference. Check payment status from your signed-in account.</p>');
  const id = verifyReturnToken(req.params.token);
  for (const parameters of [req.query, req.body]) {
    if (parameters?.order_id !== undefined && parameters.order_id !== id)
      throw new HttpError(400, 'Payment order reference does not match');
  }
  let row = await findOrder(id);
  let unverified = false;
  try {
    // Never trust the status/amount received through the browser callback.
    row = await syncOrder(row, { force: true });
  } catch (error) {
    unverified = true;
    req.log?.warn({ orderId: id, status: error.status }, 'Return payment verification deferred');
  }
  const download = req.query.download === '1';
  if (download && (unverified || row.payment_status !== 'CHARGED'))
    throw new HttpError(409, 'A receipt is available only after payment verification');
  if (download) res.set('Content-Disposition', `attachment; filename="Merabetta-receipt-${id}.html"`);
  return res.status(unverified ? 202 : 200).type('html').send(receiptHtml(row, { unverified, download }));
}
