import { startImageCleanupWorker } from './admin/products/image-storage.js';
import { app } from './app.js';
import { env } from './config/env.js';
import { sequelize } from './config/database.js';
import { logger } from './config/logger.js';
import { startCatalogSyncWorker } from './app/redcliffe-labs/catalog.js';

import { startPaymentReconciliation } from './app/orders/reconcile.js';
await sequelize.authenticate();
const stopImageCleanupWorker = startImageCleanupWorker();
const stopPaymentReconciliation = startPaymentReconciliation();
const stopCatalogSyncWorker = startCatalogSyncWorker();
const server = app.listen(env.PORT, () =>
  logger.info({ port: env.PORT }, 'API listening'),
);
server.requestTimeout = 30000;
server.headersTimeout = 15000;
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  stopCatalogSyncWorker();
  stopPaymentReconciliation();
  logger.info({ signal }, 'Shutting down');
  const timeout = setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => {
    try {
      await stopImageCleanupWorker();
      await sequelize.close();
      clearTimeout(timeout);
      process.exitCode = 0;
    } catch (err) {
      logger.error({ err }, 'Shutdown failed');
      process.exitCode = 1;
    }
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
