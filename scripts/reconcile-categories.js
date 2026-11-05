import { readFile, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  auditCategories,
  planCategoryReconciliation,
  readCategorySnapshot,
  applyCategoryReconciliation,
  CategoryReconciliationError,
} from '../src/shared/category-reconciliation.js';

const flags = new Set([
  '--dry-run',
  '--apply',
  '--report',
  '--approved-report',
  '--proposal',
  '--before-import',
  '--help',
]);
const options = {};
let connection, output;
try {
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (!flags.has(flag) || Object.hasOwn(options, flag))
      throw new CategoryReconciliationError('Unknown or repeated option');
    options[flag] = ['--dry-run', '--apply', '--help'].includes(flag)
      ? true
      : process.argv[++index];
    if (
      options[flag] === undefined ||
      (typeof options[flag] === 'string' && options[flag].startsWith('--'))
    )
      throw new CategoryReconciliationError('Missing option value');
  }
  if (options['--help']) {
    console.log(
      'Default: read-only audit and reconciliation preview.\nnode scripts/reconcile-categories.js --dry-run --report review.json [--before-import snapshot.json]\nApply only after separate approval: CONFIRM_CATEGORY_RECONCILIATION=YES node scripts/reconcile-categories.js --apply --approved-report review.json --report result.json',
    );
  } else {
    if (options['--apply'] && options['--dry-run'])
      throw new CategoryReconciliationError('Choose dry run or apply');
    if (
      options['--apply'] &&
      (process.env.CONFIRM_CATEGORY_RECONCILIATION !== 'YES' ||
        !options['--approved-report'])
    )
      throw new CategoryReconciliationError(
        'Writes disabled: apply needs explicit confirmation and an approved dry-run report',
      );
    const proposalPath = path.resolve(
      options['--proposal'] ?? 'seed/category-import/reconciliation-proposal.json',
    );
    const proposal = z
      .object({
        version: z.literal(1),
        categoryMap: z.record(
          z.string().regex(/^[1-9][0-9]*$/),
          z.string().regex(/^[1-9][0-9]*$/),
        ),
        reason: z.string().optional(),
      })
      .strict()
      .parse(JSON.parse(await readFile(proposalPath, 'utf8')));
    const workbook = JSON.parse(
      await readFile(
        new URL('../seed/category-import/categories.json', import.meta.url),
        'utf8',
      ),
    );
    const beforeImport = options['--before-import']
      ? JSON.parse(await readFile(path.resolve(options['--before-import']), 'utf8'))
      : undefined;
    if (options['--report']) {
      const destination = path.resolve(options['--report']);
      if (
        [proposalPath, options['--approved-report'], options['--before-import']]
          .filter(Boolean)
          .some((file) => path.resolve(file) === destination)
      )
        throw new CategoryReconciliationError('Report must not overwrite an input file');
      output = await open(destination, 'wx', 0o600);
    }
    const { sequelize } = await import('../src/config/database.js');
    const { env } = await import('../src/config/env.js');
    connection = sequelize;
    connection.options.logging = false;
    const target = {
      database: env.DB_NAME,
      connectionFingerprint: createHash('sha256')
        .update(JSON.stringify([env.DB_HOST, env.DB_PORT, env.DB_NAME, env.DB_USER]))
        .digest('hex'),
    };
    let report;
    if (options['--apply']) {
      const approved = JSON.parse(
        await readFile(path.resolve(options['--approved-report']), 'utf8'),
      );
      if (
        approved.plan?.mode !== 'dry-run' ||
        !/^[a-f0-9]{64}$/.test(approved.plan.planHash)
      )
        throw new CategoryReconciliationError(
          'Expected an approved audit dry-run report',
        );
      const { publishProductCatalog } =
        await import('../src/shared/catalog-publisher.js');
      const backup = path.join(
        os.tmpdir(),
        `merabetta-category-reconciliation-before-${Date.now()}.json`,
      );
      const result = await applyCategoryReconciliation({
        connection,
        proposal,
        target,
        approvedPlanHash: approved.plan.planHash,
        publish: publishProductCatalog,
        snapshotReader: async (db, transaction) => {
          const snapshot = await readCategorySnapshot(db, transaction);
          await writeFile(backup, JSON.stringify(snapshot, null, 2), {
            flag: 'wx',
            mode: 0o600,
          });
          return snapshot;
        },
        log: (event) => console.log(JSON.stringify({ staged: true, ...event })),
      });
      report = { plan: result, backup };
    } else {
      report = await connection.transaction(async (transaction) => {
        await connection.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
          { transaction },
        );
        const snapshot = await readCategorySnapshot(connection, transaction);
        return {
          capturedAt: new Date().toISOString(),
          audit: auditCategories(snapshot, workbook, beforeImport),
          plan: planCategoryReconciliation(snapshot, proposal, target),
        };
      });
    }
    if (output) await output.writeFile(JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    console.log(
      options['--apply']
        ? 'Reconciliation transaction committed. No category rows or S3 objects deleted.'
        : 'Dry run complete: production SELECTs only; no database or S3 writes. Separate approval required for apply.',
    );
    if (report.plan.conflicts.length) process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof CategoryReconciliationError) console.error(error.message);
  else if (error instanceof z.ZodError) console.error('Invalid reconciliation proposal');
  else
    console.error(
      `Category audit/reconciliation stopped (${error.name ?? 'Error'}${error.original?.code ? `, SQLSTATE ${error.original.code}` : ''}); raw SQL and credentials are not logged`,
    );
  process.exitCode = 1;
} finally {
  await output?.close();
  if (connection) await connection.close();
}
