import { readFileSync } from 'node:fs';
import { Sequelize } from 'sequelize';
import { env } from './env.js';
import { logger } from './logger.js';
import { sanitizeSql } from '../shared/log-sanitizer.js';

export const sequelize = new Sequelize(env.DB_NAME, env.DB_USER, env.DB_PASSWORD, {
  host: env.DB_HOST,
  port: env.DB_PORT,
  dialect: 'postgres',
  benchmark: true,
  logQueryParameters: false,
  logging:
    env.NODE_ENV === 'development' && env.LOG_SQL
      ? (sql, durationMs) =>
          logger.info({ sql: sanitizeSql(sql), durationMs }, 'SQL query')
      : false,
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  dialectOptions: {
    statement_timeout: 15000,
    ...(env.DB_SSL
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(env.DB_SSL_CA_FILE
              ? { ca: readFileSync(env.DB_SSL_CA_FILE, 'utf8') }
              : {}),
          },
        }
      : {}),
  },
});
