import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  validateCategorySource,
  planCategoryImport,
  inspectCategoryObject,
  normalizeCategoryName,
} from '../src/shared/category-import.js';

const source = new URL('../seed/category-import/', import.meta.url);
const load = (filename) => readFile(new URL(filename, source));
const manifest = JSON.parse(await load('categories.json'));
const images = await validateCategorySource(manifest, load);

test('workbook extraction reproduces all 8 image hashes and all 201 children without silently dropping review items', async () => {
  const { stdout } = await promisify(execFile)(
    'python3',
    [
      fileURLToPath(new URL('./extract-category-workbook.py', import.meta.url)),
      fileURLToPath(new URL('Category & Sub category.xlsx', source)),
    ],
    { maxBuffer: 5 * 1024 * 1024 },
  );
  const extracted = JSON.parse(stdout);
  for (const category of extracted.categories) {
    assert.deepEqual(
      Buffer.from(category.image_base64, 'base64'),
      images.get(category.name).buffer,
    );
    delete category.image_base64;
  }
  assert.deepEqual(extracted, manifest);
  assert.equal(images.size, 8);
  assert.equal(
    manifest.categories.reduce((n, category) => n + category.subcategories.length, 0),
    201,
  );
  assert.equal(manifest.warnings.length, 4);
  assert.equal(manifest.categories.at(-1).subcategories.length, 14);
});

test('dry-run matching is case insensitive, scoped to parent, preserves URLs and resolves global slug collisions', async () => {
  const selected = { ...manifest, categories: manifest.categories.slice(0, 2) };
  const rows = [
    {
      category_id: '1',
      parent_category_id: null,
      category_name: ' COMFORT &  FURNITURE ',
      slug: 'comfort-furniture',
      category_image: 'https://existing.invalid/keep.png',
    },
    {
      category_id: '2',
      parent_category_id: '1',
      category_name: 'air mattress anti-decubitus',
      slug: 'air-mattress',
    },
    {
      category_id: '3',
      parent_category_id: null,
      category_name: 'Unrelated',
      slug: 'daily-living',
    },
    {
      category_id: '4',
      parent_category_id: '3',
      category_name: 'Adult Diaper Pants',
      slug: 'unrelated-pants',
    },
  ];
  let inspections = 0;
  const plan = await planCategoryImport({
    manifest: selected,
    images,
    rows,
    inspectObject: async () => {
      inspections++;
      return { action: 'upload' };
    },
  });
  assert.equal(inspections, 1);
  assert.equal(plan.summary.parentExisting, 1);
  assert.equal(plan.summary.childExisting, 1);
  assert.equal(plan.summary.imageUrlsPreserved, 1);
  assert.equal(plan.groups[0].id, '1');
  assert.equal(plan.groups[0].image.action, 'preserve');
  assert.equal(plan.groups[1].slug, 'daily-living-2');
  assert.equal(plan.groups[1].children[0].action, 'insert');
  assert.equal(normalizeCategoryName(' DAILY  LIVING '), 'daily living');
  const ambiguous = await planCategoryImport({
    manifest: selected,
    images,
    rows: [...rows, { ...rows[0], category_id: '5' }],
    inspectObject: async () => ({ action: 'upload' }),
  });
  assert.equal(ambiguous.conflicts[0].code, 'AMBIGUOUS_PARENT');
  assert.equal(
    ambiguous.summary.childBlocked,
    selected.categories[0].subcategories.length,
  );
  const resolved = await planCategoryImport({
    manifest: selected,
    images,
    rows: [...rows, { ...rows[0], category_id: '5' }],
    parentSelections: { 'Comfort & Furniture': '1' },
    inspectObject: async () => ({ action: 'upload' }),
  });
  assert.equal(resolved.conflicts.length, 0);
  assert.equal(resolved.groups[0].id, '1');
  const wrongSelection = await planCategoryImport({
    manifest: selected,
    images,
    rows,
    parentSelections: { 'Comfort & Furniture': '9999' },
    inspectObject: async () => ({ action: 'upload' }),
  });
  assert.equal(wrongSelection.conflicts[0].code, 'AMBIGUOUS_PARENT');
});

test('source validation rejects tampered bytes, unsafe asset paths and duplicate names', async () => {
  await assert.rejects(
    validateCategorySource(manifest, async () => Buffer.from('tampered')),
    /checksum/,
  );
  const changed = structuredClone(manifest);
  changed.categories[0].image_file = '../credentials';
  await assert.rejects(validateCategorySource(changed, load), /image path/);
  changed.categories[0] = structuredClone(manifest.categories[0]);
  changed.categories[0].subcategories.push(changed.categories[0].subcategories[0]);
  await assert.rejects(validateCategorySource(changed, load), /Duplicate source child/);
});

test('read-only S3 inspection distinguishes missing, identical, conflicting and inaccessible objects', async () => {
  const info = images.values().next().value;
  const missing = {
    send: async () => {
      throw Object.assign(new Error(), { name: 'NotFound' });
    },
  };
  assert.equal((await inspectCategoryObject(missing, info)).action, 'upload');
  const make = (bytes) => ({
    send: async (command) => {
      assert.ok(
        ['HeadObjectCommand', 'GetObjectCommand'].includes(command.constructor.name),
      );
      return command.constructor.name === 'HeadObjectCommand'
        ? { ContentLength: bytes.length }
        : { Body: Readable.from([bytes]) };
    },
  });
  assert.equal((await inspectCategoryObject(make(info.buffer), info)).action, 'reuse');
  assert.equal(
    (await inspectCategoryObject(make(Buffer.from('different')), info)).action,
    'conflict',
  );
  const denied = {
    send: async () => {
      throw Object.assign(new Error(), { name: 'AccessDenied' });
    },
  };
  assert.equal((await inspectCategoryObject(denied, info)).action, 'conflict');
});

test('CLI refuses apply before connecting unless confirmation and an approved report are provided', async () => {
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./import-categories.js', import.meta.url)), '--apply'],
      { env: { ...process.env, CONFIRM_CATEGORY_IMPORT: '' } },
    ),
    (error) => error.code === 1 && error.stderr.includes('Writes disabled'),
  );
});
