import { readFile, writeFile } from 'node:fs/promises';
import { sequelize } from '../src/config/database.js';
import {
  inspectConfigurationConversion,
  applyConfigurationConversion,
} from '../src/shared/configuration-conversion.js';
const args = process.argv.slice(2);
try {
  const groupArg = args.find((a) => a.startsWith('--groups='));
  const groups = groupArg ? groupArg.slice(9).split(',') : [];
  const stockSource = args.includes('--accept-variant-stock') ? 'variants' : 'strict';
  if (stockSource === 'variants' && !groups.length)
    throw Error('Explicit variant stock policy requires a reviewed --groups scope');
  if (groups.some((id) => !/^\d+$/.test(id)))
    throw Error('Use positive numeric --groups=id,id');
  if (args.includes('--schema')) {
    if (!args.includes('--apply'))
      console.log(
        'Schema 039 only. Review backup and obtain separate approval, then pass --schema --apply. No changes made.',
      );
    else
      await sequelize.transaction(async (transaction) => {
        await sequelize.query("SET LOCAL lock_timeout='10s'", { transaction });
        await sequelize.query('SELECT pg_advisory_xact_lock(771209)', { transaction });
        await sequelize.query(
          await readFile(
            new URL(
              '../sql/039-configuration-product-compatibility.sql',
              import.meta.url,
            ),
            'utf8',
          ),
          { transaction },
        );
        console.log('Configuration schema 039 applied; no product conversion performed.');
      });
  } else if (args.includes('--apply')) {
    const fingerprint = args.find((a) => a.startsWith('--fingerprint='))?.slice(14);
    console.log(
      JSON.stringify(
        await applyConfigurationConversion(fingerprint, groups, { stockSource }),
        null,
        2,
      ),
    );
  } else {
    const plan = await sequelize.transaction(
      { readOnly: true, isolationLevel: 'REPEATABLE READ' },
      async (transaction) => {
        await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
        return inspectConfigurationConversion(transaction, groups, { stockSource });
      },
    );
    await writeFile(
      'CONFIGURATION-PRODUCTS-PREVIEW.json',
      JSON.stringify(plan, null, 2),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        read_only: true,
        schema_ready: plan.schema_ready,
        planned: plan.planned.length,
        conflicts: plan.conflicts.length,
        fingerprint: plan.fingerprint,
        report: 'CONFIGURATION-PRODUCTS-PREVIEW.json',
      }),
    );
  }
} finally {
  await sequelize.close();
}
