import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { customerPhone } from '../../shared/customer.schema.js';
import { HttpError } from '../../shared/errors.js';
import {
  lockOtpContact,
  matchesOtp,
  OTP_MAX_ATTEMPTS,
} from '../../shared/customer-otp.js';
import { loginLimiter } from '../../shared/security.js';
import { requestOtp } from '../auth/auth.controller.js';
import { linkVerifiedContact, lockAccountLinking } from './link-contact.js';
import {
  createCustomerSession,
  sendCustomerSession,
} from '../../shared/customer-session.js';
import { getCustomerAccount } from './customer.controller.js';

export async function requestPhoneVerification(req, res) {
  const phone = req.validated.phone;

  let result;
  await requestOtp(
    {
      ...req,
      phoneVerificationCustomerId: req.credential.id,
      validated: { method: 'phone', contact: phone },
    },
    {
      json: (value) => {
        result = value;
      },
    },
  );
  res.json(result);
}
export async function verifyProfilePhone(req, res) {
  const customerId = req.credential.id;
  const { challengeId, code } = req.validated;
  const success = await sequelize.transaction(async (transaction) => {
    await lockAccountLinking(transaction);
    const [binding] = await sequelize.query(
      'SELECT challenge_id FROM customer_phone_verifications WHERE challenge_id=:id AND customer_id=:customerId',
      {
        replacements: { id: challengeId, customerId },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    if (!binding) return false;
    const pending = await models.customerOtpChallenge.findByPk(challengeId, {
      transaction,
    });
    if (!pending || pending.method !== 'phone') return false;
    await lockOtpContact('phone', pending.contact, transaction);
    const customer = await models.customer.findByPk(customerId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!customer) throw new HttpError(401, 'Account unavailable');
    const challenge = await models.customerOtpChallenge.findByPk(challengeId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      challenge.consumedAt ||
      challenge.expiresAt <= new Date() ||
      challenge.attempts >= OTP_MAX_ATTEMPTS
    )
      return false;
    if (!matchesOtp(challenge, code)) {
      await challenge.increment('attempts', { transaction });
      return false;
    }
    const linkedId = await linkVerifiedContact(
      customerId,
      'phone',
      challenge.contact,
      transaction,
    );
    await challenge.update({ consumedAt: new Date() }, { transaction });
    return {
      customerId: linkedId,
      token:
        linkedId !== customerId
          ? await createCustomerSession(linkedId, req, transaction)
          : null,
    };
  });
  if (!success)
    throw new HttpError(422, 'Incorrect, expired or already used verification code');
  const account = await getCustomerAccount(success.customerId);
  if (success.token) sendCustomerSession(req, res, account, success.token);
  else res.json(account);
}
export const phoneVerificationRoutes = [
  {
    method: 'post',
    path: '/me/phone/request',
    auth: true,
    schema: z.object({ phone: customerPhone }).strict(),
    middleware: [loginLimiter()],
    handler: requestPhoneVerification,
  },
  {
    method: 'post',
    path: '/me/phone/verify',
    auth: true,
    schema: z
      .object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) })
      .strict(),
    middleware: [loginLimiter()],
    handler: verifyProfilePhone,
  },
];
