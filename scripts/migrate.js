import { readFileSync } from 'node:fs';
import { sequelize } from '../src/config/database.js';
import { seedMasters } from './seed-masters.js';
import { Lab } from '../src/models/lab.model.js';
import { logger } from '../src/config/logger.js';
try {
  await sequelize.transaction(async transaction => {
    await sequelize.query("SELECT pg_advisory_xact_lock(771209)", { transaction });
    await sequelize.query(readFileSync(new URL('../sql/001-customers.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/002-masters.sql', import.meta.url), 'utf8'), { transaction });
    await seedMasters(transaction);
    await sequelize.query(readFileSync(new URL('../sql/003-customer-session-lifetime.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/004-labs.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/005-admin-management.sql', import.meta.url), 'utf8'), { transaction });
    const labs = JSON.parse(readFileSync(new URL('../seed/labs.json', import.meta.url), 'utf8'));
    await Lab.bulkCreate(labs, { ignoreDuplicates: true, transaction });
  });
  logger.info('Database schema ready.');
} finally { await sequelize.close(); }
