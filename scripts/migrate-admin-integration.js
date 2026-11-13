import { readFile } from 'node:fs/promises';
import { sequelize } from '../src/config/database.js';

try {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(771209)', { transaction });
    await sequelize.query("SET LOCAL lock_timeout = '10s'", { transaction });
    await sequelize.query(
      await readFile(
        new URL('../sql/035-admin-integration-gaps.sql', import.meta.url),
        'utf8',
      ),
      { transaction },
    );
  });
  console.log('Admin product details, warehouses and image storage schema ready.');
} finally {
  await sequelize.close();
}
