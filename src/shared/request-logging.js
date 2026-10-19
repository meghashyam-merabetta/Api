import { env } from '../config/env.js';
import { sanitizeLogValue } from './log-sanitizer.js';

export function logRequestPayload(req, res, next) {
  if (req.path.startsWith('/api/app/customers/me/phone/')) return next();
  if (req.path.startsWith('/api/app/customers/me/email/')) return next();
  if (req.path.startsWith('/api/app/contact-enquiries')) return next();
  if (req.path.startsWith('/api/app/auth/otp/')) return next();
  if (req.path.startsWith('/api/payments/') || req.path.startsWith('/api/app/orders'))
    return next();
  if (
    req.path.startsWith('/api/app/redcliffe') ||
    req.path.startsWith('/api/app/lab-bookings')
  )
    return next();
  if (req.path.startsWith('/api/app/locations')) return next();
  if (env.NODE_ENV !== 'development' || !env.LOG_API_PAYLOADS) return next();

  let responseBody;
  const originalJson = res.json;
  res.json = function (body) {
    responseBody = sanitizeLogValue(body);
    return originalJson.call(this, body);
  };

  res.once('finish', () => {
    req.log.info(
      {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        query: sanitizeLogValue(req.query),
        payload: sanitizeLogValue(req.body),
        response: responseBody,
      },
      'API payload / response',
    );
  });
  next();
}
