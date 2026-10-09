import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { HttpError } from './errors.js';
import {
  signToken,
  verifyToken,
  cookieName,
  cookieOptions,
  setAuthCookie,
} from './tokens.js';

const dummyHash = await bcrypt.hash(randomUUID(), 12);
const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email });
export function createAuth(realm, User, Session) {
  async function issue(res, user) {
    const id = randomUUID();
    const token = signToken(realm, user.id, id);
    await Session.create({
      id,
      realm,
      userId: user.id,
      expiresAt: realm === 'admin' ? new Date(Date.now() + 86400000) : null,
    });
    setAuthCookie(res, realm, token);
    res.json({ user: publicUser(user) });
  }
  return {
    login: async (req, res) => {
      const user = await User.unscoped().findOne({
        where: { email: req.validated.email, realm },
      });
      const valid = await bcrypt.compare(
        req.validated.password,
        user?.passwordHash ?? dummyHash,
      );
      if (!user || !valid || !user.active)
        throw new HttpError(401, 'Invalid email or password');
      await issue(res, user);
    },
    authenticate: async (req, res, next) => {
      const token = req.cookies[cookieName(realm)];
      if (!token) throw new HttpError(401, 'Authentication required');
      let payload;
      try {
        payload = verifyToken(realm, token);
        z.uuid().parse(payload.sub);
        z.uuid().parse(payload.jti);
      } catch {
        throw new HttpError(401, 'Invalid or expired authentication');
      }
      const session = await Session.findOne({
        where: { id: payload.jti, userId: payload.sub, realm },
      });
      if (!session || (session.expiresAt && session.expiresAt.getTime() <= Date.now()))
        throw new HttpError(401, 'Session expired or revoked');
      const user = await User.findOne({ where: { id: payload.sub, realm } });
      if (!user?.active) throw new HttpError(401, 'Account unavailable');
      req.auth = { realm, userId: user.id, sessionId: session.id };
      req.user = publicUser(user);
      const credential = user.get({ plain: true });
      delete credential.passwordHash;
      req.credential = credential;
      if (realm === 'app') setAuthCookie(res, realm, token);
      next();
    },
    me: (req, res) => res.json({ user: req.user }),
    logout: async (req, res) => {
      await Session.destroy({
        where: { id: req.auth.sessionId, userId: req.auth.userId, realm },
      });
      res.clearCookie(cookieName(realm), cookieOptions(realm));
      res.status(204).end();
    },
    logoutAll: async (req, res) => {
      await Session.destroy({ where: { userId: req.auth.userId, realm } });
      res.clearCookie(cookieName(realm), cookieOptions(realm));
      res.status(204).end();
    },
  };
}
