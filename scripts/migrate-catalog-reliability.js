import { readFile } from 'node:fs/promises';
import { sequelize } from '../src/config/database.js';

// For existing catalog installations; avoids unrelated legacy bootstrap migrations.
try {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(771209)', { transaction });
    await sequelize.query(
      await readFile(
        new URL('../sql/027-admin-catalog-reliability.sql', import.meta.url),
        'utf8',
      ),
      { transaction },
    );
  });
  console.log('Catalog reliability tables ready.');
} finally {
  await sequelize.close();
}
