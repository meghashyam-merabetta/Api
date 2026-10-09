import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { UniqueConstraintError } from 'sequelize';
import { env } from './config/env.js';
import { sequelize } from './config/database.js';
import { logger } from './config/logger.js';
import { logRequestPayload } from './shared/request-logging.js';
import { csrfGuard } from './shared/security.js';
import { isTrustedOrigin } from './config/origins.js';
import { apiRoutes } from './routes/index.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) =>
      `${req.method} ${req.url.split('?')[0]} → ${res.statusCode}`,
    customErrorMessage: (req, res) =>
      `${req.method} ${req.url.split('?')[0]} → ${res.statusCode} Request failed`,
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
);
app.use(logRequestPayload);
app.use(helmet());
app.use(
  cors((req, callback) =>
    callback(null, {
      origin: isTrustedOrigin(req.get('origin'), req.path),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-App-Client'],
    }),
  ),
);
app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});
app.use(
  '/api',
  rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(csrfGuard);
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());
app.use('/api', apiRoutes);
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof ZodError)
    return res.status(422).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  if (err instanceof UniqueConstraintError)
    return res.status(409).json({ error: 'Account already exists' });
  const status =
    Number.isInteger(err.status) && err.status >= 400 && err.status < 500
      ? err.status
      : 500;
  if (status === 500) req.log.error({ err }, 'Request failed');
  res
    .status(status)
    .json({ error: status === 500 ? 'Internal server error' : err.message });
});
