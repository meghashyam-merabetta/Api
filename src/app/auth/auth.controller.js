import { models } from '../../models/index.js';
import { randomUUID, randomInt } from 'node:crypto';
import { Op } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import {
  createCustomerSession,
  sendCustomerSession,
  clearCustomerCookie,
} from '../../shared/customer-session.js';
import {
  hashOtp,
  matchesOtp,
  lockOtpContact,
  OTP_EXPIRY_SECONDS,
  OTP_RESEND_SECONDS,
  OTP_MAX_ATTEMPTS,
} from '../../shared/customer-otp.js';
import { getCustomerAccount } from '../customers/customer.controller.js';
import { sendLoginOtp, stplConfig } from '../stpl/client.js';
export { getProfile as me } from '../customers/customer.controller.js';

export async function requestOtp(req, res) {
  const sms = env.OTP_MODE === 'stpl';
  if (!sms && (env.NODE_ENV === 'production' || env.OTP_MODE !== 'development')) {
    throw new HttpError(503, 'OTP delivery provider is not configured');
  }

  const { method, contact } = req.validated;
  if (sms) {
    if (method !== 'phone')
      throw new HttpError(
        422,
        'Use your mobile number to receive an OTP. Email OTP is not enabled.',
      );
    stplConfig();
  }
  const id = randomUUID();
  const code = String(randomInt(100000, 1000000));

  await sequelize.transaction(async (transaction) => {
    await lockOtpContact(method, contact, transaction);
    const recentChallenge = await models.customerOtpChallenge.findOne({
      where: {
        method,
        contact,
        createdAt: { [Op.gt]: new Date(Date.now() - OTP_RESEND_SECONDS * 1000) },
      },
      transaction,
    });
    if (recentChallenge) {
      throw new HttpError(429, 'Wait 30 seconds before requesting another OTP');
    }

    await models.customerOtpChallenge.update(
      { consumedAt: new Date() },
      { where: { method, contact, consumedAt: null }, transaction },
    );
    await models.customerOtpChallenge.create(
      {
        id,
        method,
        contact,
        codeHash: hashOtp(id, code),
        expiresAt: new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000),
      },
      { transaction },
    );
  });

  if (sms) {
    try {
      const delivery = await sendLoginOtp(contact, code, id);
      await sequelize.query(
        'UPDATE customer_otp_challenges SET delivery_response=CAST(:delivery AS jsonb) WHERE id=:id',
        { replacements: { id, delivery: JSON.stringify(delivery) }, logging: false },
      );
    } catch (error) {
      await models.customerOtpChallenge.update(
        { consumedAt: new Date() },
        { where: { id } },
      );
      throw error;
    }
  }
  res.json({
    challengeId: id,
    expiresIn: OTP_EXPIRY_SECONDS,
    resendAfter: OTP_RESEND_SECONDS,
    ...(!sms ? { devCode: code } : {}),
    devCode: code,
    delivery: sms ? 'sms' : 'development',
  });
}

export async function verifyOtp(req, res) {
  const { challengeId, code } = req.validated;
  const result = await sequelize.transaction(async (transaction) => {
    const pending = await models.customerOtpChallenge.findByPk(challengeId, {
      transaction,
    });
    if (!pending) return null;

    // Use the same lock order as resend to avoid deadlocks.
    await lockOtpContact(pending.method, pending.contact, transaction);
    const challenge = await models.customerOtpChallenge.findByPk(challengeId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.expiresAt <= new Date() ||
      challenge.attempts >= OTP_MAX_ATTEMPTS
    ) {
      return null;
    }

    if (!matchesOtp(challenge, code)) {
      await challenge.increment('attempts', { transaction });
      // Commit failed attempts; throwing inside this transaction would roll them back.
      return null;
    }

    let identity = await models.customerIdentity.findOne({
      where: { method: challenge.method, contact: challenge.contact },
      transaction,
    });
    if (!identity) {
      const customer = await models.customer.create(
        {
          [challenge.method]: challenge.contact,
          isAppRegister: true,
        },
        { transaction },
      );
      identity = await models.customerIdentity.create(
        {
          customerId: customer.id,
          method: challenge.method,
          contact: challenge.contact,
        },
        { transaction },
      );
    }

    await challenge.update({ consumedAt: new Date() }, { transaction });
    const account = await getCustomerAccount(identity.customerId, transaction);
    const token = await createCustomerSession(identity.customerId, req, transaction);
    return { account, token };
  });

  if (!result) throw new HttpError(401, 'Incorrect, expired or already used OTP');
  sendCustomerSession(req, res, result.account, result.token);
}

export async function logout(req, res) {
  await models.customerLoginLog.destroy({
    where: { id: req.auth.sessionId, customerId: req.credential.id },
  });
  clearCustomerCookie(res);
  res.status(204).end();
}

export async function logoutAll(req, res) {
  await models.customerLoginLog.destroy({ where: { customerId: req.credential.id } });
  clearCustomerCookie(res);
  res.status(204).end();
}
