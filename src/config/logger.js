import pino from 'pino';
import { env } from './env.js';
export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: process.stdout.isTTY === true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname,req,res',
            singleLine: false,
          },
        },
      }
    : {}),
  redact: [
    'req.headers.cookie',
    'req.headers.authorization',
    'res.headers["set-cookie"]',
  ],
});
