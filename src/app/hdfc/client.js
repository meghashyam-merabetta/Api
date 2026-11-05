import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { loadJwtKeys, encryptGatewayPayload, decryptGatewayPayload } from './jwt.js';
import { gatewayTransport } from './transport.js';
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
    !env.HDFC_JWT_KEY_ID ||
    !env.HDFC_JWT_PRIVATE_KEY_PATH ||
    !env.HDFC_JWT_BANK_PUBLIC_KEY_PATH ||
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
  if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password || u.port || isIP(u.hostname.replace(/^\[|\]$/g, '')) || !u.hostname.includes('.') || /\.(localhost|local|internal)$/.test(u.hostname) || u.pathname.replace(/\/$/, '') !== '/api/payments/hdfc/return')
    throw new HttpError(503, 'A public HTTPS payment return URL is required.');
  return loadJwtKeys(env);
}
export async function gatewayRequest(path, customerId, body) {
  const keys = requireGateway();
  if (path !== '/session' && !/^\/orders\/[A-Za-z0-9]{1,20}$/.test(path))
    throw Error('Invalid gateway path');
  const session = path === '/session';
  if (session !== Boolean(body)) throw Error('Invalid gateway request');
  const log = {
    provider: 'hdfc',
    providerRequestId: randomUUID(),
    endpoint: path,
    method: session ? 'POST' : 'GET',
  };
  const start = Date.now();
  await recordProviderCall(log);
  let stage = 'request';
  let httpStatus;
  try {
    const encrypted = await encryptGatewayPayload(session ? body : { order_id: path.slice('/orders/'.length) }, keys);
    const response = await gatewayTransport.request(gatewayOrigin() + (session ? '/v4/session' : '/v4/order-status'), {
      method: log.method,
      headers: {
        'x-merchantid': env.HDFC_MERCHANT_ID,
        'x-customerid': customerId,
        'x-resellerid': 'hdfc_reseller',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(encrypted),
    });
    httpStatus = response.status;
    stage = 'http';
    if (response.status < 200 || response.status >= 300) {
      const error = new HttpError(502, [401, 403].includes(response.status)
        ? 'HDFC payment access was rejected. Please contact support to check the JWT configuration. Your cart is unchanged.'
        : 'HDFC could not verify this request. Please check your saved order.');
      error.gatewayStatus = response.status;
      throw error;
    }
    // Plaintext or incorrectly signed successes must never update an order.
    stage = 'response_verification';
    const data = await decryptGatewayPayload(JSON.parse(response.text), keys);
    await recordProviderCall({
      ...log,
      httpStatus: response.status,
      // Persist only the reconciliation fields; never SDK tokens, keys, links or customer PII.
      responseBody: JSON.stringify(Object.fromEntries(
        ['order_id', 'merchant_id', 'status', 'status_id', 'amount', 'currency', 'txn_id', 'gateway_id', 'gateway', 'test_mode']
          .filter(key => ['string', 'number', 'boolean'].includes(typeof data[key]))
          .map(key => [key, data[key]]),
      )),
      durationMs: Date.now() - start,
      providerStatus:
        typeof data?.status === 'string' && /^[A-Z_]{1,40}$/.test(data.status)
          ? data.status
          : null,
    });
    return data;
  } catch (e) {
    await recordProviderCall({
      ...log,
      httpStatus: e.gatewayStatus ?? httpStatus,
      durationMs: Date.now() - start,
      failure: ['TimeoutError', 'AbortError'].includes(e.name) ? 'timeout' : stage === 'http' ? 'gateway_http_error' : stage === 'response_verification' ? 'gateway_response_verification_error' : 'gateway_request_error',
    });
    throw e instanceof HttpError
      ? e
      : new HttpError(
          502,
          'Payment status is not confirmed yet. Please check your saved order.',
        );
  }
}
