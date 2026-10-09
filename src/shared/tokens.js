import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
const secret = (realm) => (realm === 'admin' ? env.ADMIN_JWT_SECRET : env.APP_JWT_SECRET);
export function signToken(realm, userId, sessionId) {
  return jwt.sign({ realm }, secret(realm), {
    algorithm: 'HS256',
    issuer: 'auth-api',
    audience: realm,
    subject: userId,
    jwtid: sessionId,
    ...(realm === 'admin' ? { expiresIn: '1d' } : {}),
  });
}
export function verifyToken(realm, token) {
  const payload = jwt.verify(token, secret(realm), {
    algorithms: ['HS256'],
    issuer: 'auth-api',
    audience: realm,
  });
  if (
    payload.realm !== realm ||
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string'
  )
    throw new Error('Invalid token');
  return payload;
}
export const cookieName = (realm) => `${realm}_auth`;
export const cookieOptions = (realm) => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: env.COOKIE_SAME_SITE,
  path: `/api/${realm}`,
});
export function setAuthCookie(res, realm, token) {
  res.cookie(cookieName(realm), token, {
    ...cookieOptions(realm),
    maxAge: (realm === 'admin' ? 1 : 400) * 86400000,
  });
}
