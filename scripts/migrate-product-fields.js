import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { sequelize } from '../src/config/database.js';
import {
  inspectProductFieldStorage,
  applyProductFieldStorage,
  restoreProductFieldColumns,
} from './lib/product-field-migration.js';
const args = process.argv.slice(2);
const value = (name) =>
  args.find((a) => a.startsWith(name + '='))?.slice(name.length + 1);
try {
  if (args.includes('--apply') || args.includes('--restore')) {
    const path = value('--backup-file'),
      expected = value('--backup-sha256');
    if (!path || !expected || !value('--fingerprint'))
      throw Error(
        'Separate approval, a fresh reviewed fingerprint and a restricted verified backup are required before apply/restore',
      );
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.mode & 0o077)
      throw Error('Backup must be a non-empty regular file readable only by its owner');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw Error('Backup checksum mismatch');
    const verify = spawnSync(
      process.env.PRODUCT_PG_RESTORE_BIN || 'pg_restore',
      ['--file', '/dev/null', path],
      { encoding: 'utf8' },
    );
    if (verify.status !== 0)
      throw Error('Complete custom-format backup read verification failed');
    console.log(
      JSON.stringify(
        args.includes('--restore')
          ? await restoreProductFieldColumns(value('--fingerprint'))
          : await applyProductFieldStorage(value('--fingerprint')),
        null,
        2,
      ),
    );
  } else {
    const plan = await sequelize.transaction(
      { readOnly: true, isolationLevel: 'REPEATABLE READ' },
      async (transaction) => {
        await sequelize.query('SET TRANSACTION READ ONLY', {
          transaction,
          productStorage: false,
        });
        return inspectProductFieldStorage(transaction);
      },
    );
    await writeFile('PRODUCT-FIELD-STORAGE-PREVIEW.json', JSON.stringify(plan, null, 2), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        read_only: true,
        migrated: plan.migrated,
        fields_to_move: plan.fields_to_move.length,
        conflicts: plan.conflicts,
        fingerprint: plan.fingerprint,
        report: 'PRODUCT-FIELD-STORAGE-PREVIEW.json',
      }),
    );
  }
} finally {
  await sequelize.close();
}
