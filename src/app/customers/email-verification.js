import { randomUUID, randomInt } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from '../../config/database.js';
import { env } from '../../config/env.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { customerEmail } from '../../shared/customer.schema.js';
import {
  hashOtp,
  matchesOtp,
  lockOtpContact,
  OTP_MAX_ATTEMPTS,
} from '../../shared/customer-otp.js';
import { loginLimiter } from '../../shared/security.js';
import { sendEmailOtp, smtpConfig } from '../email/client.js';
import { linkVerifiedContact, lockAccountLinking } from './link-contact.js';
import {
  createCustomerSession,
  sendCustomerSession,
} from '../../shared/customer-session.js';
import { getCustomerAccount } from './customer.controller.js';

export async function requestEmailVerification(req, res) {
  const email = req.validated.email,
    customerId = req.credential.id;
  const smtp = env.EMAIL_OTP_MODE === 'smtp';
  if (
    !smtp &&
    !(
      env.NODE_ENV !== 'production' &&
      env.EMAIL_OTP_MODE === 'inherit' &&
      env.OTP_MODE === 'development'
    )
  )
    throw new HttpError(
      503,
      'Email verification is not configured. Please contact support.',
    );
  if (smtp) smtpConfig();
  const id = randomUUID(),
    code = String(randomInt(100000, 1000000));
  await sequelize.transaction(async (transaction) => {
    await lockOtpContact('email', email, transaction);
    const customer = await models.customer.findByPk(customerId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!customer) throw new HttpError(401, 'Account unavailable');

    const recent = await sequelize.query(
      "SELECT id FROM customer_email_verifications WHERE customer_id=:customerId AND created_at>now()-interval '30 seconds' LIMIT 1",
      { replacements: { customerId }, type: QueryTypes.SELECT, transaction },
    );
    if (recent.length)
      throw new HttpError(429, 'Wait 30 seconds before requesting another code.');
    await sequelize.query(
      'UPDATE customer_email_verifications SET consumed_at=now() WHERE customer_id=:customerId AND consumed_at IS NULL',
      { replacements: { customerId }, transaction },
    );
    await sequelize.query(
      "INSERT INTO customer_email_verifications(id,customer_id,email,code_hash,expires_at) VALUES(:id,:customerId,:email,:hash,now()+interval '5 minutes')",
      {
        replacements: { id, customerId, email, hash: hashOtp(id, code) },
        transaction,
        logging: false,
      },
    );
  });
  if (smtp) {
    try {
      await sendEmailOtp(email, code, 300);
    } catch (error) {
      await sequelize.query(
        'UPDATE customer_email_verifications SET consumed_at=now() WHERE id=:id',
        { replacements: { id } },
      );
      throw error;
    }
  }
  res.json({
    challengeId: id,
    expiresIn: 300,
    resendAfter: 30,
    ...(!smtp ? { devCode: code } : {}),
  });
}

export async function verifyProfileEmail(req, res) {
  const customerId = req.credential.id,
    { challengeId, code } = req.validated;
  const verified = await sequelize.transaction(async (transaction) => {
    await lockAccountLinking(transaction);
    const [pending] = await sequelize.query(
      'SELECT * FROM customer_email_verifications WHERE id=:id AND customer_id=:customerId',
      {
        replacements: { id: challengeId, customerId },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (!pending) return false;
    await lockOtpContact('email', pending.email, transaction);
    const customer = await models.customer.findByPk(customerId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!customer) throw new HttpError(401, 'Account unavailable');
    const [row] = await sequelize.query(
      'SELECT * FROM customer_email_verifications WHERE id=:id AND customer_id=:customerId FOR UPDATE',
      {
        replacements: { id: challengeId, customerId },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (
      !row ||
      row.consumed_at ||
      new Date(row.expires_at) <= new Date() ||
      row.attempts >= OTP_MAX_ATTEMPTS
    )
      return false;
    if (!matchesOtp({ id: row.id, codeHash: row.code_hash }, code)) {
      await sequelize.query(
        'UPDATE customer_email_verifications SET attempts=attempts+1 WHERE id=:id',
        { replacements: { id: row.id }, transaction },
      );
      return false;
    }
    const linkedId = await linkVerifiedContact(
      customerId,
      'email',
      row.email,
      transaction,
    );
    await models.customerOtpChallenge.update(
      { consumedAt: new Date() },
      { where: { method: 'email', contact: row.email, consumedAt: null }, transaction },
    );

    await sequelize.query(
      'UPDATE customer_email_verifications SET consumed_at=now() WHERE id=:id',
      { replacements: { id: row.id }, transaction },
    );
    return {
      customerId: linkedId,
      token:
        linkedId !== customerId
          ? await createCustomerSession(linkedId, req, transaction)
          : null,
    };
  });
  if (!verified)
    throw new HttpError(422, 'Incorrect, expired or already used verification code');
  const account = await getCustomerAccount(verified.customerId);
  if (verified.token) sendCustomerSession(req, res, account, verified.token);
  else res.json(account);
}

export const emailVerificationRoutes = [
  {
    method: 'post',
    path: '/me/email/request',
    auth: true,
    schema: z.object({ email: customerEmail }).strict(),
    middleware: [loginLimiter()],
    handler: requestEmailVerification,
  },
  {
    method: 'post',
    path: '/me/email/verify',
    auth: true,
    schema: z
      .object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) })
      .strict(),
    middleware: [loginLimiter()],
    handler: verifyProfileEmail,
  },
];
