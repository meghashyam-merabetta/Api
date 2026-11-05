import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  validateCategorySource,
  planCategoryImport,
  inspectCategoryObject,
  executeCategoryImport,
} from '../src/shared/category-import.js';

test(
  'category import preserves IDs/products, is repeatable, serializes concurrent runs and recovers uploaded objects after rollback',
  { skip: process.env.RUN_CATEGORY_IMPORT_DB_TESTS !== 'true' },
  async () => {
    assert.match(process.env.DB_NAME, /^codex_category_import_test/);
    const { sequelize } = await import('../src/config/database.js');
    const { models } = await import('../src/models/index.js');
    const { categoryTree, listCategories, getCategory } =
      await import('../src/admin/categories/categories.controller.js');
    const Category = models.category.schema('public');
    const source = new URL('../seed/category-import/', import.meta.url);
    const manifest = JSON.parse(
      await readFile(new URL('categories.json', source), 'utf8'),
    );
    const subset = {
      ...manifest,
      categories: manifest.categories.slice(0, 2).map((category) => ({
        ...category,
        subcategories: [category.subcategories[0], { name: 'Shared child', cell: 'A99' }],
      })),
    };
    const images = await validateCategorySource(subset, (file) =>
      readFile(new URL(file, source)),
    );
    const objects = new Map();
    const calls = [];
    let preconditionRace;
    const s3 = {
      send: async (command) => {
        const name = command.constructor.name;
        const { Key, Body } = command.input;
        calls.push(name);
        assert.equal(command.input.Bucket, 'prod-merabetta');
        if (name === 'PutObjectCommand') {
          assert.equal(command.input.IfNoneMatch, '*');
          if (preconditionRace) {
            objects.set(
              Key,
              preconditionRace === 'same'
                ? Buffer.from(Body)
                : Buffer.from('conflicting concurrent upload'),
            );
            preconditionRace = null;
            throw Object.assign(new Error(), { name: 'PreconditionFailed' });
          }
          if (objects.has(Key))
            throw Object.assign(new Error(), { name: 'PreconditionFailed' });
          objects.set(Key, Buffer.from(Body));
          return {};
        }
        if (!objects.has(Key)) throw Object.assign(new Error(), { name: 'NotFound' });
        if (name === 'HeadObjectCommand')
          return { ContentLength: objects.get(Key).length };
        if (name === 'GetObjectCommand')
          return { Body: Readable.from([objects.get(Key)]) };
        throw Error('Forbidden operation: ' + name);
      },
    };
    const preview = async (input = subset, imageMap = images) =>
      planCategoryImport({
        manifest: input,
        images: imageMap,
        rows: await Category.findAll({ raw: true }),
        inspectObject: (info) => inspectCategoryObject(s3, info),
      });
    const apply = (plan, input = subset, imageMap = images) =>
      executeCategoryImport({
        connection: sequelize,
        Category,
        manifest: input,
        images: imageMap,
        s3,
        approvedPlanHash: plan.planHash,
      });
    try {
      await sequelize.query(
        await readFile(
          new URL('../sql/023-admin-catalog-base.sql', import.meta.url),
          'utf8',
        ),
      );
      // This focused importer fixture needs the new read metadata, but no inventory conversion.
      await sequelize.query(
        'ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by UUID, ADD COLUMN IF NOT EXISTS updated_by UUID',
      );
      await sequelize.query('TRUNCATE categories,products RESTART IDENTITY CASCADE');
      const existing = await Category.create({
        category_name: 'COMFORT & FURNITURE',
        slug: 'comfort-furniture',
        category_image: 'https://existing.invalid/preserved.png',
        description: 'Keep description',
        is_active: false,
      });
      const child = await Category.create({
        category_name: 'air mattress anti-decubitus',
        slug: 'existing-child',
        parent_category_id: existing.category_id,
      });
      const [products] = await sequelize.query(
        "INSERT INTO products(name,slug) VALUES ('Preserve product','preserve-product') RETURNING id",
      );
      await sequelize.query(
        'INSERT INTO product_categories(product_id,category_id,is_primary) VALUES(:product,:category,true)',
        { replacements: { product: products[0].id, category: child.category_id } },
      );
      const before = await Category.count();
      const plan = await preview();
      assert.equal(await Category.count(), before);
      assert.equal(objects.size, 0);
      assert.ok(calls.every((name) => name === 'HeadObjectCommand'));
      assert.equal(plan.summary.parentExisting, 1);
      assert.equal(plan.summary.childExisting, 1);
      assert.equal(plan.summary.imageUploads, 1);
      await assert.rejects(apply({ ...plan, planHash: '0'.repeat(64) }), /stale/);
      assert.equal(objects.size, 0);
      const concurrent = await Promise.allSettled([apply(plan), apply(plan)]);
      assert.equal(
        concurrent.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
      const preserved = await Category.findByPk(existing.category_id);
      assert.equal(preserved.category_image, 'https://existing.invalid/preserved.png');
      assert.equal(preserved.description, 'Keep description');
      assert.equal(preserved.is_active, false);
      const [associations] = await sequelize.query('SELECT * FROM product_categories');
      assert.equal(associations.length, 1);
      assert.equal(String(associations[0].category_id), String(child.category_id));
      const [shared] = await sequelize.query(
        "SELECT count(DISTINCT parent_id)::int AS parents FROM categories WHERE name='Shared child'",
      );
      assert.equal(shared[0].parents, 2);
      const next = await preview();
      assert.equal(
        next.summary.parentInserts +
          next.summary.childInserts +
          next.summary.imageUploads,
        0,
      );
      const puts = calls.filter((name) => name === 'PutObjectCommand').length;
      await apply(next);
      assert.equal(calls.filter((name) => name === 'PutObjectCommand').length, puts);
      // Existing GET contracts keep category_image and expose image_url as an alias.
      let response;
      await categoryTree(
        { validatedQuery: {} },
        {
          json: (data) => {
            response = data;
          },
        },
      );
      const daily = response.data.find((row) => row.category_name === 'Daily Living');
      assert.match(
        daily.image_url,
        /^https:\/\/prod-merabetta\.s3\.ap-south-1\.amazonaws\.com\/categories\//,
      );
      assert.equal(daily.category_image, daily.image_url);
      assert.equal(daily.subcategories.length, 2);
      await getCategory(
        { validatedParams: { categoryId: daily.category_id } },
        {
          json: (data) => {
            response = data;
          },
        },
      );
      assert.equal(response.data.toJSON().image_url, daily.image_url);
      await listCategories(
        { validatedQuery: { parent_category_id: daily.category_id } },
        {
          json: (data) => {
            response = data;
          },
        },
      );
      assert.equal(response.data.length, 2);
      // Upload success + later database failure leaves an immutable object for safe reuse.
      const recoverySource = { ...manifest, categories: [manifest.categories[2]] };
      const recoveryImages = await validateCategorySource(recoverySource, (file) =>
        readFile(new URL(file, source)),
      );
      const recoverPlan = await preview(recoverySource, recoveryImages);
      const countBefore = await Category.count();
      const originalCreate = Category.create;
      Category.create = async () => {
        throw Error('Injected database failure');
      };
      try {
        await assert.rejects(
          apply(recoverPlan, recoverySource, recoveryImages),
          /Injected/,
        );
      } finally {
        Category.create = originalCreate;
      }
      assert.equal(await Category.count(), countBefore);
      const reusable = await preview(recoverySource, recoveryImages);
      assert.equal(reusable.summary.imageReuses, 1);
      await apply(reusable, recoverySource, recoveryImages);
      // Conflicting bytes are reported, never overwritten or linked.
      const conflictingSource = { ...manifest, categories: [manifest.categories[3]] };
      const conflictingImages = await validateCategorySource(conflictingSource, (file) =>
        readFile(new URL(file, source)),
      );
      objects.set(
        conflictingImages.values().next().value.key,
        Buffer.from('unrelated bytes'),
      );
      const conflict = await preview(conflictingSource, conflictingImages);
      assert.equal(conflict.conflicts[0].code, 'IMAGE_CONFLICT');
      await assert.rejects(
        apply(conflict, conflictingSource, conflictingImages),
        /unresolved conflicts/,
      );
      const raceSource = { ...manifest, categories: [manifest.categories[4]] };
      const raceImages = await validateCategorySource(raceSource, (file) =>
        readFile(new URL(file, source)),
      );
      const racePlan = await preview(raceSource, raceImages);
      preconditionRace = 'same';
      await apply(racePlan, raceSource, raceImages);
      const badRaceSource = { ...manifest, categories: [manifest.categories[5]] };
      const badRaceImages = await validateCategorySource(badRaceSource, (file) =>
        readFile(new URL(file, source)),
      );
      const badRacePlan = await preview(badRaceSource, badRaceImages);
      const beforeRaceCount = await Category.count();
      preconditionRace = 'different';
      await assert.rejects(
        apply(badRacePlan, badRaceSource, badRaceImages),
        /Concurrent storage conflict/,
      );
      assert.equal(await Category.count(), beforeRaceCount);
      const replacementPlan = await planCategoryImport({
        manifest: subset,
        images,
        rows: await Category.findAll({ raw: true }),
        replaceMatching: true,
        inspectObject: (info) => inspectCategoryObject(s3, info),
      });
      assert.equal(replacementPlan.summary.imageReplacements, 1);
      const oldObject = Buffer.from('old production image');
      objects.set('legacy-image.png', oldObject);
      await executeCategoryImport({
        connection: sequelize,
        Category,
        manifest: subset,
        images,
        s3,
        replaceMatching: true,
        approvedPlanHash: replacementPlan.planHash,
      });
      const replacedRoot = await Category.findByPk(existing.category_id);
      assert.equal(replacedRoot.category_name, subset.categories[0].name);
      assert.equal(
        replacedRoot.category_image,
        images.get(subset.categories[0].name).url,
      );
      assert.equal(replacedRoot.is_active, false);
      assert.equal(replacedRoot.description, 'Keep description');
      assert.equal(
        (await Category.findByPk(child.category_id)).category_name,
        subset.categories[0].subcategories[0].name,
      );
      assert.deepEqual(objects.get('legacy-image.png'), oldObject);
      const [afterLinks] = await sequelize.query('SELECT * FROM product_categories');
      assert.deepEqual(afterLinks, associations);
      const rerun = await planCategoryImport({
        manifest: subset,
        images,
        rows: await Category.findAll({ raw: true }),
        replaceMatching: true,
        inspectObject: (info) => inspectCategoryObject(s3, info),
      });
      assert.equal(
        rerun.summary.parentUpdates +
          rerun.summary.childUpdates +
          rerun.summary.parentInserts +
          rerun.summary.childInserts +
          rerun.summary.imageUploads +
          rerun.summary.imageAssignments,
        0,
      );
      assert.equal(calls.includes('DeleteObjectCommand'), false);
    } finally {
      await sequelize.close();
    }
  },
);
