import { readFileSync } from 'node:fs';
import { sequelize } from '../src/config/database.js';
try {
  await sequelize.transaction(async transaction => {
    await sequelize.query("SET LOCAL lock_timeout = '10s'", { transaction });
    await sequelize.query(readFileSync(new URL('../sql/037-hdfc-sdk-sessions.sql', import.meta.url), 'utf8'), { transaction });
  });
  console.log('HDFC SDK session schema ready.');
} finally { await sequelize.close(); }
