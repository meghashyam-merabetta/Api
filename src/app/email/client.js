import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import { otpEmail } from './template.js';

export function smtpConfig() {
  if (
    !env.SMTP_HOST ||
    !env.SMTP_USER ||
    !env.SMTP_PASSWORD ||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(env.SMTP_FROM)
  )
    throw new HttpError(503, 'Email OTP delivery is not configured.');
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}
export async function sendEmailOtp(
  contact,
  code,
  expiresIn,
  createTransport = nodemailer.createTransport,
) {
  const transport = createTransport(smtpConfig());
  try {
    const result = await transport.sendMail({
      from: { name: 'MeraBetta', address: env.SMTP_FROM },
      to: { address: contact },
      ...otpEmail(code, expiresIn),
    });
    if (!result.accepted?.length || result.rejected?.length)
      throw new Error('Recipient not accepted');
    return { provider: 'smtp', accepted: true };
  } catch {
    throw new HttpError(502, 'Could not send the verification email. Please try again.');
  } finally {
    transport.close();
  }
}
