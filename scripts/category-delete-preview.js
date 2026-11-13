// Read-only audit. This command has no apply mode and never runs a migration.
import { writeFile } from 'node:fs/promises';
import { previewCategoryDeletion } from '../src/shared/category-deletion.js';
import { sequelize } from '../src/config/database.js';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !/^\d+(,\d+)*$/.test(args[0])))
    throw new Error('Usage: node scripts/category-delete-preview.js [28,36]');
  const ids = (args[0] ?? '28,36').split(',');
  const report = {
    generated_at: new Date().toISOString(),
    read_only: true,
    plan: await previewCategoryDeletion(ids),
  };
  await writeFile(
    'CATEGORY-DELETE-DRY-RUN.json',
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      {
        ...report.plan.counts,
        fingerprint: report.plan.fingerprint,
        required_migrations: report.plan.required_migrations,
        report: 'CATEGORY-DELETE-DRY-RUN.json',
      },
      null,
      2,
    ),
  );
} finally {
  await sequelize.close();
}
