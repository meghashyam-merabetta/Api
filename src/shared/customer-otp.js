import { createHmac, timingSafeEqual } from 'node:crypto';
import { sequelize } from '../config/database.js';
import { env } from '../config/env.js';

export const OTP_EXPIRY_SECONDS = 600;
export const OTP_RESEND_SECONDS = 30;
export const OTP_MAX_ATTEMPTS = 5;

export function hashOtp(id, code) {
  return createHmac('sha256', env.APP_JWT_SECRET)
    .update(id + ':' + code)
    .digest('hex');
}

export function matchesOtp(challenge, code) {
  return timingSafeEqual(
    Buffer.from(challenge.codeHash, 'hex'),
    Buffer.from(hashOtp(challenge.id, code), 'hex'),
  );
}

export async function lockOtpContact(method, contact, transaction) {
  // Protect contacts without a customer row. Sequelize has no advisory-lock model API.
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
    replacements: { key: method + ':' + contact },
    transaction,
  });
}
