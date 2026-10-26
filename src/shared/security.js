import { rateLimit } from 'express-rate-limit';
import { isTrustedOrigin } from '../config/origins.js';
import { HttpError } from './errors.js';
export const loginLimiter = () =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts; try again later' },
  });
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Public, cookie-independent form submissions do not use customer authority.
  if (req.method === 'POST' && req.path === '/api/app/contact-enquiries') {
    if (!req.is('application/json'))
      throw new HttpError(415, 'Content-Type must be application/json');
    return next();
  }
  const nativeAppRequest =
    req.path.startsWith('/api/app/') &&
    req.get('x-app-client') === 'native' &&
    !req.get('sec-fetch-site') &&
    !req.get('cookie');

  // Expo's native HTTP stack can attach an Origin. Native clients use bearer
  // tokens, never ambient browser cookies; browser requests retain Origin checks.
  if (nativeAppRequest) {
    if (!req.is('application/json'))
      throw new HttpError(415, 'Content-Type must be application/json');
    return next();
  }

  // Required even for login/register to prevent login CSRF. CLI clients must send Origin too.
  if (!isTrustedOrigin(req.get('origin'), req.path)) {
    req.log?.warn(
      {
        origin: req.get('origin') || '(missing)',
        client: req.get('x-app-client') || 'browser',
        path: req.path,
      },
      'Origin rejected. Add the browser origin to ALLOWED_ORIGINS; native apps must send X-App-Client: native.',
    );
    throw new HttpError(
      403,
      'App origin is not allowed. Check API ALLOWED_ORIGINS configuration.',
    );
  }
  // Image uploads and replacements use multipart bodies after the Origin check.
  const imageMultipart =
    (req.method === 'POST' && /^\/api\/admin\/products\/[^/]+\/images$/.test(req.path)) ||
    (req.method === 'PUT' &&
      /^\/api\/admin\/products\/[^/]+\/images\/[^/]+$/.test(req.path));
  if (imageMultipart) {
    if (!req.is('multipart/form-data'))
      throw new HttpError(415, 'Content-Type must be multipart/form-data');
    return next();
  }
  if (!req.is('application/json'))
    throw new HttpError(415, 'Content-Type must be application/json');
  next();
}
