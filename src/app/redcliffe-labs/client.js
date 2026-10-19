import { recordProviderCall } from '../../shared/provider-log.js';
import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';

export const paths = Object.freeze({
  packages: '/api/external/v2/center-package-data/',
  parameters: '/api/external/v2/package-parameter-data/',
  slots: '/api/booking/v2/get-time-slot-list/',
  create: '/api/external/v2/center-create-booking/',
  confirm: '/api/external/v2/center-confirm-booking/',
  booking: '/api/external/v2/center-get-booking/',
  update: '/api/external/v2/center-update-booking/',
});

export function slotErrorMessage(data, fallback) {
  const value = [
    data?.message,
    data?.detail,
    data?.error,
    data?.data?.message,
    data?.errors?.message,
  ].find((item) => typeof item === 'string' && item.trim());
  if (!value || /<[^>]+>/.test(value)) return fallback;
  return (
    env.REDCLIFFE_API_KEY ? value.replaceAll(env.REDCLIFFE_API_KEY, '[redacted]') : value
  ).slice(0, 500);
}

export async function providerRequest(
  path,
  { query = {}, page, body, fetchImpl = fetch } = {},
) {
  if (!env.REDCLIFFE_BASE_URL || !env.REDCLIFFE_API_KEY)
    throw new HttpError(
      503,
      'Redcliffe Labs is not configured yet. Please try again later.',
    );
  const base = new URL(env.REDCLIFFE_BASE_URL);
  if (
    base.protocol !== 'https:' &&
    !(env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(base.hostname))
  )
    throw new HttpError(503, 'Redcliffe Labs configuration requires HTTPS.');
  if (
    !Object.values(paths).includes(path) &&
    !/^\/api\/external\/v2\/(open-add-member\/[1-9]\d*\/|open-set-package\/[1-9]\d*\/)$/.test(
      path,
    )
  )
    throw new Error('Unknown provider endpoint');
  const url = new URL(path, base.origin);
  url.search = new URLSearchParams(query).toString();
  if (page !== undefined) url.searchParams.set('page', String(page));
  const started = Date.now();
  const context = {
    provider: 'redcliffe',
    providerRequestId: randomUUID(),
    endpoint: path,
    method: body ? 'POST' : 'GET',
  };
  logger.info(context, 'Third-party request started');
  await recordProviderCall(context);
  try {
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: {
        Key: env.REDCLIFFE_API_KEY,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const responseBody = await response.text();
    let data = null;
    try {
      data = JSON.parse(responseBody);
    } catch {
      /* Preserve non-JSON responses too. */
    }
    const responseStatus =
      typeof data?.status === 'string' && /^[a-zA-Z _-]{1,40}$/.test(data.status)
        ? data.status
        : undefined;
    const validationFields =
      body && data && typeof data === 'object'
        ? Object.keys(body).filter((field) => Object.hasOwn(data, field))
        : [];
    await recordProviderCall({
      ...context,
      responseBody,
      httpStatus: response.status,
      durationMs: Date.now() - started,
      providerStatus: responseStatus,
      validationFields,
    });
    logger[response.ok ? 'info' : 'warn'](
      {
        ...context,
        httpStatus: response.status,
        durationMs: Date.now() - started,
        providerStatus: responseStatus,
        jsonResponse: data !== null,
        validationFields,
      },
      'Third-party response received',
    );
    if (!response.ok && path === paths.slots) {
      throw new HttpError(
        response.status,
        slotErrorMessage(
          data,
          response.status === 504
            ? '504 Gateway Timeout'
            : `Slot API error (${response.status})`,
        ),
      );
    }
    if (!response.ok) throw new Error('Provider HTTP error');
    if (data === null) throw new Error('Provider returned non-JSON response');
    return data;
  } catch (error) {
    await recordProviderCall({
      ...context,
      durationMs: Date.now() - started,
      failure:
        error?.name === 'TimeoutError'
          ? 'timeout'
          : error instanceof HttpError || error?.message === 'Provider HTTP error'
            ? 'provider_http_error'
            : error?.message === 'Provider returned non-JSON response'
              ? 'invalid_response'
              : 'network_error',
    });
    logger.warn(
      {
        ...context,
        durationMs: Date.now() - started,
        failure:
          error?.name === 'TimeoutError'
            ? 'timeout'
            : error instanceof HttpError
              ? 'provider_http_error'
              : error?.message === 'Provider HTTP error'
                ? 'provider_http_error'
                : error?.message === 'Provider returned non-JSON response'
                  ? 'invalid_response'
                  : 'network_error',
      },
      'Third-party request failed',
    );
    if (path === paths.slots && error instanceof HttpError) throw error;
    if (path === paths.slots && error?.name === 'TimeoutError')
      throw new HttpError(504, 'Collection slots request timed out. Please retry.');
    // Never expose credentials, upstream URLs, response bodies or patient data in errors.
    throw new HttpError(
      502,
      body
        ? 'Booking response could not be verified. Please check My Orders before trying again.'
        : 'Redcliffe Labs could not be reached. Please try again.',
    );
  }
}

export function providerSucceeded(data) {
  return typeof data?.status === 'string' && data.status.toLowerCase() === 'success';
}

export function findProviderBooking(body, id) {
  const rows = Array.isArray(body)
    ? body
    : providerSucceeded(body) && Array.isArray(body?.data)
      ? body.data
      : [];
  return rows.find((row) => String(row.booking_id ?? row.pk) === String(id));
}
