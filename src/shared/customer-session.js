import { createHash, randomBytes } from 'node:crypto';
import { Op } from 'sequelize';
import { env } from '../config/env.js';
import { Customer, CustomerLoginLog } from '../models/customer.model.js';
import { HttpError } from './errors.js';

// Browsers cap cookie lifetime; renew on use while the server session stays valid.
const COOKIE_DURATION_MS = 400 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'customer_auth';
const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: env.COOKIE_SAME_SITE,
  path: '/api/app',
};

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function clearCustomerCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions);
}

export function sendCustomerSession(req, res, account, token) {
  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: COOKIE_DURATION_MS });
  const nativeClient = req.get('x-app-client') === 'native';
  res.json({ ...account, ...(nativeClient ? { token } : {}) });
}

export async function createCustomerSession(customerId, req, transaction) {
  const token = randomBytes(32).toString('hex');
  await CustomerLoginLog.create(
    {
      customerId,
      tokenHash: hashToken(token),
      expiresAt: null,
      deviceInfo: req.validated.deviceInfo || {},
      userAgent: (req.get('user-agent') || '').slice(0, 512),
      ipAddress: req.ip?.slice(0, 64) || null,
    },
    { transaction },
  );
  return token;
}

export async function authenticateCustomer(req, res, next) {
  const authorization = req.get('authorization');
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice(7)
    : req.get('x-app-client') === 'native'
      ? null
      : req.cookies?.[COOKIE_NAME];

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new HttpError(401, 'Login required');
  }

  const session = await CustomerLoginLog.findOne({
    where: {
      tokenHash: hashToken(token),
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
    },
    include: [{ model: Customer, as: 'customer', required: true }],
  });
  if (!session) {
    clearCustomerCookie(res);
    throw new HttpError(401, 'Session expired. Please log in again.');
  }

  req.auth = { userId: session.customerId, sessionId: session.id, realm: 'app' };
  req.credential = session.customer.get({ plain: true });
  if (req.get('x-app-client') !== 'native') {
    res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: COOKIE_DURATION_MS });
  }
  next();
}
