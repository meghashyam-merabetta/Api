import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import { recordProviderCall } from '../../shared/provider-log.js';
export const gatewayOrigin = () =>
  env.HDFC_ENVIRONMENT === 'production'
    ? 'https://smartgateway.hdfc.bank.in'
    : 'https://smartgateway.hdfcuat.bank.in';
export function paymentUrl(value) {
  try {
    const u = new URL(value);
    return u.origin === gatewayOrigin() && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
export function requireGateway() {
  if (
    !env.HDFC_API_KEY ||
    !env.HDFC_MERCHANT_ID ||
    !env.HDFC_CLIENT_ID ||
    !env.HDFC_RETURN_URL
  )
    throw new HttpError(503, 'Payments are not configured yet. Please try later.');
  let u;
  try {
    u = new URL(env.HDFC_RETURN_URL);
  } catch {
    throw new HttpError(503, 'Payment return URL is not configured.');
  }
  if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password)
    throw new HttpError(503, 'A public HTTPS payment return URL is required.');
}
export async function gatewayRequest(path, customerId, body) {
  requireGateway();
  if (path !== '/session' && !/^\/orders\/[A-Za-z0-9]{1,20}$/.test(path))
    throw Error('Invalid gateway path');
  const log = {
    provider: 'hdfc',
    providerRequestId: randomUUID(),
    endpoint: path,
    method: body ? 'POST' : 'GET',
  };
  const start = Date.now();
  await recordProviderCall(log);
  try {
    const r = await fetch(gatewayOrigin() + path, {
      method: log.method,
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: 'Basic ' + Buffer.from(env.HDFC_API_KEY).toString('base64'),
        'x-merchantid': env.HDFC_MERCHANT_ID,
        'x-customerid': customerId,
        'x-resellerid': 'hdfc_reseller',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json().catch(() => null);
    await recordProviderCall({
      ...log,
      httpStatus: r.status,
      durationMs: Date.now() - start,
      providerStatus:
        typeof data?.status === 'string' && /^[A-Z_]{1,40}$/.test(data.status)
          ? data.status
          : null,
    });
    if (!r.ok || !data)
      throw new HttpError(
        502,
        'Payment gateway is temporarily unavailable. Your order is saved; check its payment status before trying again.',
      );
    return data;
  } catch (e) {
    await recordProviderCall({
      ...log,
      durationMs: Date.now() - start,
      failure: e.name === 'TimeoutError' ? 'timeout' : 'gateway_error',
    });
    throw e instanceof HttpError
      ? e
      : new HttpError(
          502,
          'Payment status is not confirmed yet. Please check your saved order.',
        );
  }
}
