import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import { recordProviderCall } from '../../shared/provider-log.js';

export function msg91Config() {
  if (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID)
    throw new HttpError(503, 'SMS service configuration is incomplete.');
}

export async function sendMsg91Otp(
  phone,
  code,
  challengeId,
  { fetchImpl = fetch, logCall = recordProviderCall } = {},
) {
  msg91Config();
  if (!/^[6-9]\d{9}$/.test(phone) || !/^\d{6}$/.test(code))
    throw new HttpError(422, 'Invalid OTP request.');
  const started = Date.now();
  const log = {
    provider: 'msg91',
    providerRequestId: challengeId,
    endpoint: '/api/v5/flow',
    method: 'POST',
  };
  await logCall(log);
  try {
    const response = await fetchImpl('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: 'application/json',
        authkey: env.MSG91_AUTH_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        template_id: env.MSG91_TEMPLATE_ID,
        // This template names the greeting variable "OTP"; "num" holds the login code.
        recipients: [{ mobiles: '91' + phone, OTP: 'Customer', num: code }],
      }),
    });
    const data = await response.json().catch(() => null);
    const accepted =
      response.ok &&
      data?.type === 'success' &&
      typeof data.message === 'string' &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(data.message);
    await logCall({
      ...log,
      httpStatus: response.status,
      providerStatus: accepted ? 'success' : 'error',
      durationMs: Date.now() - started,
      ...(!accepted ? { failure: 'sms_rejected' } : {}),
    });
    if (!accepted)
      throw new HttpError(
        502,
        'OTP could not be sent. Please wait 30 seconds and try again.',
      );
    return { provider: 'msg91', requestId: data.message, state: 'accepted' };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    await logCall({
      ...log,
      durationMs: Date.now() - started,
      failure: error.name === 'TimeoutError' ? 'timeout' : 'network_error',
    });
    throw new HttpError(
      502,
      'OTP delivery could not be confirmed. Please wait 30 seconds and request a new OTP.',
    );
  }
}
