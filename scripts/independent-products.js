import { readFile, writeFile } from 'node:fs/promises';
import { sequelize } from '../src/config/database.js';
import { inspectProductMigration } from '../src/shared/product-migration-plan.js';
import { convertIndependentProducts } from '../src/shared/convert-independent-products.js';

const options = {};
try {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (['--schema', '--apply'].includes(flag)) options[flag.slice(2)] = true;
    else if (
      ['--fingerprint', '--output'].includes(flag) &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    )
      options[flag.slice(2)] = args[++index];
    else
      throw new Error(
        'Usage: independent-products.js [--schema] [--apply] [--fingerprint HASH] [--output FILE]',
      );
  }
  if (options.apply && options.schema) {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('SELECT pg_advisory_xact_lock(771209)', { transaction });
      await sequelize.query("SET LOCAL lock_timeout='10s'", { transaction });
      await sequelize.query(
        await readFile(
          new URL('../sql/036-independent-products-audit.sql', import.meta.url),
          'utf8',
        ),
        { transaction },
      );
    });
    console.log(
      'Independent product/audit schema applied; no legacy product conversion performed.',
    );
  } else if (options.apply) {
    console.log(
      JSON.stringify(await convertIndependentProducts(options.fingerprint), null, 2),
    );
  } else {
    const { plan } = await sequelize.transaction(
      { readOnly: true, isolationLevel: 'REPEATABLE READ' },
      async (transaction) => {
        await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
        return inspectProductMigration(transaction);
      },
    );
    const report = JSON.stringify(plan, null, 2) + '\n';
    if (options.output) await writeFile(options.output, report);
    console.log(report);
  }
} finally {
  await sequelize.close();
}
