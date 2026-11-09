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
// Retain only recognized diagnostic categories; arbitrary bank messages can contain secrets or customer data.
export function gatewayErrorDetails(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const candidates = [data.error_code, data.errorCode, data.code, data.error?.code];
    const code = candidates.find(value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value));
    const messages = [data.error_message, data.errorMessage, data.message, typeof data.error === 'string' ? data.error : data.error?.message];
    const message = messages.find(value => typeof value === 'string') || '';
    const reasons = [
      [/invalid signature|signature (?:is )?(?:invalid|verification failed)/i, 'Gateway reported an invalid signature'],
      [/(?:jwt|token).{0,30}expired|expired.{0,30}(?:jwt|token)/i, 'Gateway reported an expired JWT or token'],
      [/(?:invalid|unknown) (?:key id|key identifier|kid)/i, 'Gateway reported an invalid key ID'],
      [/(?:invalid|unknown) merchant|merchant.{0,20}not found/i, 'Gateway reported an invalid merchant'],
      [/(?:decryption|decrypt).{0,25}(?:failed|error)|unable to decrypt/i, 'Gateway could not decrypt the request'],
      [/invalid (?:credentials|authentication)|authentication failed|unauthori[sz]ed/i, 'Gateway reported an authentication failure'],
    ];
    const reason = reasons.find(([pattern]) => pattern.test(message))?.[1];
    return code || reason ? JSON.stringify({ ...(code ? { error_code: code } : {}), ...(reason ? { reason } : {}) }) : null;
  } catch { return null; }
}
export async function gatewayRequest(path, customerId, body) {
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
  let stage = 'configuration';
  let httpStatus;
  let errorDetails;
  try {
    const keys = requireGateway();
    stage = 'request';
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
      errorDetails = gatewayErrorDetails(response.text);
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
      responseBody: JSON.stringify({ order_id: session && typeof body?.order_id === 'string' && /^[A-Za-z0-9]{1,20}$/.test(body.order_id) ? body.order_id : session ? null : path.slice('/orders/'.length), environment: env.HDFC_ENVIRONMENT, stage, ...(['AbortError', 'TimeoutError'].includes(e.name) ? { reason: 'Gateway request timed out' } : {}), ...(errorDetails ? JSON.parse(errorDetails) : {}) }),
      durationMs: Date.now() - start,
      failure: ['TimeoutError', 'AbortError'].includes(e.name) ? 'timeout' : stage === 'configuration' ? 'gateway_configuration_error' : stage === 'http' ? 'gateway_http_error' : stage === 'response_verification' ? 'gateway_response_verification_error' : 'gateway_request_error',
    });
    throw e instanceof HttpError
      ? e
      : new HttpError(
          502,
          'Payment status is not confirmed yet. Please check your saved order.',
        );
  }
}
