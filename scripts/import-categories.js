import { readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import {
  validateCategorySource,
  planCategoryImport,
  inspectCategoryObject,
  executeCategoryImport,
  CategoryImportError,
  sha256,
  CATEGORY_IMPORT_REGION,
} from '../src/shared/category-import.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const allowed = new Set([
  '--apply',
  '--dry-run',
  '--workbook',
  '--manifest',
  '--report',
  '--approved-report',
  '--parent-map',
  '--replace-matching',
  '--help',
]);
const options = {};
let connection, s3, reportFile;
try {
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key) || Object.hasOwn(options, key))
      throw new CategoryImportError(`Unknown or repeated option: ${key}`);
    options[key] = ['--apply', '--dry-run', '--help', '--replace-matching'].includes(key)
      ? true
      : args[++index];
    if (
      options[key] === undefined ||
      (typeof options[key] === 'string' && options[key].startsWith('--'))
    )
      throw new CategoryImportError(`Missing value: ${key}`);
  }
  if (options['--help']) {
    console.log(
      'Default: read-only dry run.\nnode scripts/import-categories.js [--workbook source.xlsx | --manifest manifest.json] [--report report.json]\nApply only after approval: CONFIRM_CATEGORY_IMPORT=YES node scripts/import-categories.js --apply --approved-report report.json [same source options]',
    );
  } else {
    if (options['--apply'] && options['--dry-run'])
      throw new CategoryImportError('Choose --apply or --dry-run');
    if (options['--workbook'] && options['--manifest'])
      throw new CategoryImportError('Choose workbook or manifest input');
    if (
      options['--apply'] &&
      (process.env.CONFIRM_CATEGORY_IMPORT !== 'YES' || !options['--approved-report'])
    )
      throw new CategoryImportError(
        'Writes disabled: --apply requires CONFIRM_CATEGORY_IMPORT=YES and --approved-report',
      );
    const parentSelections = options['--parent-map']
      ? JSON.parse(await readFile(path.resolve(options['--parent-map']), 'utf8'))
      : {};
    if (options['--report']) {
      const destination = path.resolve(options['--report']);
      const protectedPaths = [
        options['--approved-report'],
        options['--manifest'],
        options['--workbook'],
        options['--parent-map'],
        path.join(here, '../seed/category-import/categories.json'),
      ]
        .filter(Boolean)
        .map((value) => path.resolve(value));
      if (protectedPaths.includes(destination))
        throw new CategoryImportError(
          'Report path must differ from source and approval files',
        );
      reportFile = await open(destination, 'wx', 0o600);
    }
    let manifest, images;
    if (options['--workbook']) {
      const { stdout } = await run(
        'python3',
        [
          path.join(here, 'extract-category-workbook.py'),
          path.resolve(options['--workbook']),
        ],
        { maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
      );
      manifest = JSON.parse(stdout);
      const embedded = new Map(
        manifest.categories.map((group) => [
          group.image_file,
          Buffer.from(group.image_base64, 'base64'),
        ]),
      );
      for (const group of manifest.categories) delete group.image_base64;
      images = await validateCategorySource(manifest, (filename) =>
        embedded.get(filename),
      );
    } else {
      const manifestFile = path.resolve(
        options['--manifest'] ||
          path.join(here, '../seed/category-import/categories.json'),
      );
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      images = await validateCategorySource(manifest, (filename) =>
        readFile(path.join(path.dirname(manifestFile), filename)),
      );
    }
    const { sequelize } = await import('../src/config/database.js');
    const { env } = await import('../src/config/env.js');
    const { Category } = await import('../src/models/category.model.js');
    connection = sequelize;
    // Disable SQL logging for this operational command, including error payloads.
    connection.options.logging = false;
    const Model = Category.schema('public');
    s3 = new S3Client({
      region: CATEGORY_IMPORT_REGION,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
    });
    const target = {
      database: env.DB_NAME,
      connectionFingerprint: sha256(
        JSON.stringify([env.DB_HOST, env.DB_PORT, env.DB_NAME, env.DB_USER]),
      ),
    };
    let report;
    if (options['--apply']) {
      const approved = JSON.parse(
        await readFile(path.resolve(options['--approved-report']), 'utf8'),
      );
      if (approved.mode !== 'dry-run' || !/^[a-f0-9]{64}$/.test(approved.planHash))
        throw new CategoryImportError('Expected a saved dry-run report');
      report = await executeCategoryImport({
        connection,
        Category: Model,
        manifest,
        images,
        s3,
        target,
        parentSelections,
        replaceMatching: options['--replace-matching'] === true,
        approvedPlanHash: approved.planHash,
        log: (item) => console.log(JSON.stringify(item)),
      });
    } else {
      report = await connection.transaction(async (transaction) => {
        await connection.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
          { transaction },
        );
        const rows = await Model.findAll({ raw: true, transaction });
        return planCategoryImport({
          manifest,
          images,
          rows,
          target,
          parentSelections,
          replaceMatching: options['--replace-matching'] === true,
          inspectObject: (info) => inspectCategoryObject(s3, info),
        });
      });
    }
    if (reportFile) await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    console.log(
      options['--apply']
        ? 'Import committed. Existing rows and objects preserved.'
        : 'Dry run complete. No database or S3 writes. Production apply requires separate approval.',
    );
    if (report.conflicts.length) process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof CategoryImportError) console.error(error.message);
  else if (error instanceof z.ZodError)
    console.error(
      'Invalid category source:',
      JSON.stringify(
        error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      ),
    );
  else
    console.error(
      `Category import stopped (${error.name || 'Error'}${error.original?.code ? `, SQLSTATE ${error.original.code}` : ''}). No credentials or raw database errors are printed.`,
    );
  process.exitCode = 1;
} finally {
  await reportFile?.close();
  if (connection) await connection.close();
  s3?.destroy();
}
