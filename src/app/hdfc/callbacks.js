import { timingSafeEqual } from 'node:crypto';
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
  const id = req.body?.content?.order?.order_id;
  if (typeof id !== 'string' || !/^MB(?:[0-9]{11}|[a-f0-9]{18})$/.test(id))
    return res.status(200).json({ received: true });
  let row;
  try {
    row = await findOrder(id);
  } catch (e) {
    if (e.status === 404) return res.json({ received: true });
    throw e;
  }
  await syncOrder(row);
  res.json({ received: true });
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
