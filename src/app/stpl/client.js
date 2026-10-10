import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import { recordProviderCall } from '../../shared/provider-log.js';
export function stplConfig() {
  let base;
  try {
    base = new URL(env.STPL_BASE_URL);
  } catch {
    throw new HttpError(503, 'SMS service is not configured yet.');
  }
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !env.STPL_USERNAME ||
    !env.STPL_PASSWORD ||
    !/^[a-zA-Z0-9]{6}$/.test(env.STPL_SENDER_ID) ||
    !env.STPL_TEMPLATE_ID ||
    !env.STPL_DLT_CONTENT_ID ||
    !(
      env.STPL_OTP_TEMPLATE.includes('{otp}') || env.STPL_OTP_TEMPLATE.includes('{#num#}')
    )
  )
    throw new HttpError(503, 'SMS service configuration is incomplete.');
  return new URL('/sms-api/v2/send/', base.origin);
}
export async function sendLoginOtp(
  phone,
  code,
  challengeId,
  { fetchImpl = fetch, logCall = recordProviderCall } = {},
) {
  const url = stplConfig();
  if (!/^[6-9]\d{9}$/.test(phone) || !/^\d{6}$/.test(code))
    throw new HttpError(422, 'Invalid OTP request.');
  const body = new URLSearchParams({
    username: env.STPL_USERNAME,
    password: env.STPL_PASSWORD,
    unicode: env.STPL_UNICODE,
    from: env.STPL_SENDER_ID,
    to: '91' + phone,
    text: env.STPL_OTP_TEMPLATE.replaceAll('{otp}', code)
      .replaceAll('{#num#}', code)
      .replaceAll('{#alp#}', 'Customer'),
    templateId: env.STPL_TEMPLATE_ID,
    dltContentId: env.STPL_DLT_CONTENT_ID,
  });
  const started = Date.now();
  const log = {
    provider: 'stpl',
    providerRequestId: challengeId,
    endpoint: '/sms-api/v2/send/',
    method: 'POST',
  };
  await logCall(log);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    const data = await response.json().catch(() => null);
    const state =
      typeof data?.state === 'string' && /^[A-Z_]{1,40}$/.test(data.state)
        ? data.state
        : null;
    const accepted =
      response.ok &&
      state === 'SUBMIT_ACCEPTED' &&
      /^\d+$/.test(String(data.transactionId));
    await logCall({
      ...log,
      httpStatus: response.status,
      providerStatus: state,
      durationMs: Date.now() - started,
      ...(!accepted ? { failure: 'sms_rejected' } : {}),
    });
    if (!accepted)
      throw new HttpError(
        502,
        'OTP could not be sent. Please wait 30 seconds and try again.',
      );
    return {
      transactionId: String(data.transactionId),
      state,
      pdu: Number.isSafeInteger(data.pdu) ? data.pdu : null,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const dnsFailure = ['ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code);
    await logCall({
      ...log,
      durationMs: Date.now() - started,
      failure: dnsFailure ? 'dns_error' : error.name === 'TimeoutError' ? 'timeout' : 'network_error',
    });
    if (dnsFailure) throw new HttpError(503, 'SMS service is temporarily unavailable. Please try again later.');
    throw new HttpError(
      502,
      'OTP delivery could not be confirmed. Please wait 30 seconds and request a new OTP.',
    );
  }
}
