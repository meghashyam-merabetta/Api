import { env } from '../config/env.js';
import { sanitizeLogValue } from './log-sanitizer.js';

export function logRequestPayload(req, res, next) {
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
