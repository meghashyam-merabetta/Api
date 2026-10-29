import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
const idPattern = /^MB(?:[0-9]{11}|[a-f0-9]{18})$/;
function sign(value) {
  return createHmac('sha256', env.APP_JWT_SECRET).update('hdfc-receipt-v1:' + value).digest('base64url');
}
export function paymentReturnUrl(row, now = Date.now()) {
  if (!env.HDFC_RETURN_URL) return null;
  const value = `${row.id}.${Math.floor(now / 1000) + 7 * 24 * 60 * 60}`;
  return `${env.HDFC_RETURN_URL.replace(/\/$/, '')}/${value}.${sign(value)}`;
}
export function verifyReturnToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 160) throw new HttpError(403, 'Invalid payment return link');
  const [id, expires, signature, extra] = token.split('.');
  if (extra || !idPattern.test(id || '') || !/^\d{10}$/.test(expires || '') || !signature)
    throw new HttpError(403, 'Invalid payment return link');
  const expected = Buffer.from(sign(`${id}.${expires}`));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || Number(expires) <= Math.floor(now / 1000))
    throw new HttpError(403, 'Payment return link is invalid or expired. Open your order in Merabetta.');
  return id;
}
