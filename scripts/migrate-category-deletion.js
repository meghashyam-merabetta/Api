import { readFile } from 'node:fs/promises';
import { sequelize } from '../src/config/database.js';

try {
  if (process.argv.slice(2).join(' ') !== '--apply') {
    console.log(
      'Schema only: sql/037-recursive-category-deletion-audit.sql. Review and back up the database, then pass --apply after separate approval. No changes made.',
    );
  } else {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query("SET LOCAL lock_timeout = '10s'", { transaction });
      await sequelize.query('SELECT pg_advisory_xact_lock(771209)', { transaction });
      await sequelize.query(
        await readFile(
          new URL('../sql/037-recursive-category-deletion-audit.sql', import.meta.url),
          'utf8',
        ),
        { transaction },
      );
    });
    console.log('Category deletion audit schema ready; no catalog records deleted.');
  }
} finally {
  await sequelize.close();
}
