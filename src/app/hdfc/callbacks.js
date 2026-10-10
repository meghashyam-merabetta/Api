import { timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import { findOrder, syncOrder } from '../orders/orders.controller.js';
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
  if (typeof id !== 'string' || !/^MB[a-f0-9]{18}$/.test(id))
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
export function paymentReturn(_req, res) {
  res
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(
      '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Merabetta payment</title><body><h1>Return to Merabetta</h1><p>Your payment is being verified. Return to the app and select Check payment status. Do not pay again until the status is confirmed.</p><a href="merabetta://payment-return">Open Merabetta</a></body></html>',
    );
}
