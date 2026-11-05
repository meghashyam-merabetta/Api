import { sequelize } from '../src/config/database.js';
import { reconcileProductImages } from '../src/shared/product-image-reconciliation.js';

try {
  const unknown = process.argv.slice(2).filter((value) => value !== '--apply');
  if (unknown.length)
    throw new Error('Usage: node scripts/reconcile-product-images.js [--apply]');
  const apply = process.argv.includes('--apply');
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'report-only',
        ...(await reconcileProductImages({ apply })),
      },
      null,
      2,
    ),
  );
} finally {
  await sequelize.close();
}
