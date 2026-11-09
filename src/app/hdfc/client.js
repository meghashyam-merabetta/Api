import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { loadJwtKeys, encryptGatewayPayload, decryptGatewayPayload } from './jwt.js';
import { gatewayTransport } from './transport.js';
import { safeGatewayRequest, safeGatewayResponse, safeGatewayValue } from './diagnostic-log.js';
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
export function requireGateway(mode = 'jwt') {
  if (mode !== 'jwt' && mode !== 'basic') throw new HttpError(503, 'Unknown payment gateway configuration.');
  if (
    (mode === 'jwt' && (!env.HDFC_JWT_KEY_ID || !env.HDFC_JWT_PRIVATE_KEY_PATH || !env.HDFC_JWT_BANK_PUBLIC_KEY_PATH)) ||
    (mode === 'basic' && !env.HDFC_API_KEY) ||
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
  return mode === 'jwt' ? loadJwtKeys(env) : null;
}
// Retain only recognized diagnostic categories; arbitrary bank messages can contain secrets or customer data.
export function gatewayErrorDetails(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const candidates = [data.error_code, data.errorCode, data.code, data.error?.code, data.error_info?.code];
    const code = candidates.find(value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/i.test(value));
    const messages = [data.error_message, data.errorMessage, data.message, data.error_info?.developer_message, data.error_info?.user_message, typeof data.error === 'string' ? data.error : data.error?.message];
    const message = messages.find(value => typeof value === 'string') || '';
    const reasons = [
      [/invalid signature|signature (?:is )?(?:invalid|verification failed)/i, 'Gateway reported an invalid signature'],
      [/(?:jwt|token).{0,30}expired|expired.{0,30}(?:jwt|token)/i, 'Gateway reported an expired JWT or token'],
      [/(?:invalid|unknown) (?:key id|key identifier|kid)/i, 'Gateway reported an invalid key ID'],
      [/(?:invalid|unknown) merchant|merchant.{0,20}not found/i, 'Gateway reported an invalid merchant'],
      [/(?:decryption|decrypt).{0,25}(?:failed|error)|unable to decrypt/i, 'Gateway could not decrypt the request'],
      [/invalid (?:credentials|authentication)|authentication failed|unauthori[sz]ed|access denied/i, 'Gateway reported an authentication failure'],
    ];
    const reason = reasons.find(([pattern]) => pattern.test(message))?.[1];
    return code || reason ? JSON.stringify({ ...(code ? { error_code: code } : {}), ...(reason ? { reason } : {}) }) : null;
  } catch { return null; }
}
export async function gatewayRequest(path, customerId, body, mode = 'jwt') {
  if (path !== '/session' && !/^\/orders\/[A-Za-z0-9]{1,20}$/.test(path))
    throw Error('Invalid gateway path');
  const session = path === '/session';
  if (session !== Boolean(body)) throw Error('Invalid gateway request');
  const target = mode === 'jwt' ? (session ? '/v4/session' : '/v4/order-status') : path;
  const requestDetails = safeGatewayRequest(session ? body : { order_id: path.slice('/orders/'.length) });
  const diagnostic = { order_id: requestDetails.order_id ?? null, environment: env.HDFC_ENVIRONMENT, gateway_auth_mode: mode, gateway_endpoint: target, gateway_url: gatewayOrigin() + target, request: requestDetails };
  const log = {
    provider: 'hdfc',
    providerRequestId: randomUUID(),
    endpoint: path,
    method: session || mode === 'jwt' ? 'POST' : 'GET',
    responseBody: JSON.stringify({ ...diagnostic, stage: 'started' }),
  };
  const start = Date.now();
  await recordProviderCall(log);
  let stage = 'configuration';
  let httpStatus;
  let errorDetails;
  let gatewayResponse;
  try {
    const keys = requireGateway(mode);
    stage = 'request';
    const encrypted = mode === 'jwt' ? await encryptGatewayPayload(session ? body : { order_id: path.slice('/orders/'.length) }, keys) : null;
    const response = await gatewayTransport.request(gatewayOrigin() + target, {
      method: log.method,
      headers: {
        ...(mode === 'basic' ? { Authorization: 'Basic ' + Buffer.from(env.HDFC_API_KEY + ':').toString('base64') } : {}),
        'x-merchantid': env.HDFC_MERCHANT_ID,
        'x-customerid': customerId,
        'x-resellerid': 'hdfc_reseller',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(mode === 'jwt' ? { body: JSON.stringify(encrypted) } : session ? { body: JSON.stringify(body) } : {}),
    });
    httpStatus = response.status;
    gatewayResponse = safeGatewayResponse(response.text);
    stage = 'http';
    if (response.status < 200 || response.status >= 300) {
      errorDetails = gatewayErrorDetails(response.text);
      const edgeRejected = response.status === 403 && /Generated by cloudfront/i.test(response.text);
      if (edgeRejected) errorDetails = JSON.stringify({ error_code: 'GATEWAY_EDGE_REJECTED', reason: 'CloudFront rejected the gateway request before a verified payment response was received' });
      const error = new HttpError(502, edgeRejected
        ? 'Payment confirmation is temporarily unavailable. Your payment status is not confirmed. Please do not pay again if money was debited.'
        : [401, 403].includes(response.status)
        ? 'HDFC payment access was rejected. Please contact support. Your cart is unchanged.'
        : 'HDFC could not verify this request. Please check your saved order.');
      error.gatewayStatus = response.status;
      throw error;
    }
    // Plaintext or incorrectly signed successes must never update an order.
    stage = 'response_verification';
    const parsed = JSON.parse(response.text);
    const data = mode === 'jwt' ? await decryptGatewayPayload(parsed, keys) : parsed;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid gateway response');
    await recordProviderCall({
      ...log,
      httpStatus: response.status,
      // Retain a redacted verified response; SDK credentials and personal data stay private.
      responseBody: JSON.stringify({ ...diagnostic, stage: 'completed', ...Object.fromEntries(
        ['order_id', 'merchant_id', 'status', 'status_id', 'amount', 'currency', 'txn_id', 'gateway_id', 'gateway', 'test_mode']
          .filter(key => ['string', 'number', 'boolean'].includes(typeof data[key]))
          .map(key => [key, data[key]])), request: requestDetails, response: safeGatewayValue(data), response_verified: mode === 'jwt', gateway_auth_mode: mode }),
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
      responseBody: JSON.stringify({ ...diagnostic, stage, ...(gatewayResponse !== undefined ? { response: gatewayResponse, response_verified: false } : {}), ...(['AbortError', 'TimeoutError'].includes(e.name) ? { reason: 'Gateway request timed out' } : {}), ...(errorDetails ? JSON.parse(errorDetails) : {}) }),
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
