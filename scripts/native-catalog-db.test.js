import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import bcrypt from 'bcryptjs';

test(
  'native team schema integration',
  { skip: process.env.RUN_NATIVE_CATALOG_DB_TESTS !== 'true' },
  async (t) => {
    assert.equal(process.env.DB_HOST, '127.0.0.1');
    assert.equal(process.env.DB_PORT, '55441');
    assert.match(process.env.DB_NAME, /^codex_team_schema_/);
    const { sequelize } = await import('../src/config/database.js');
    const { query } = await import('../src/catalog/store.js');
    const { models } = await import('../src/models/index.js');
    const { app } = await import('../src/app.js');
    const { assertTeamSchemaReady } = await import('../src/catalog/readiness.js');
    const { reserveTeamStock, settleTeamStock, returnTeamStock } =
      await import('../src/catalog/inventory.js');
    const agent = request.agent(app);
    const origin = 'http://localhost:5173';
    const write = (method, path, body, key) => {
      const r = agent[method]('/api/admin/' + path).set('Origin', origin);
      if (key) r.set('Idempotency-Key', key);
      return r.send(body);
    };
    const ok = (r, status = 200) => {
      assert.equal(r.status, status, JSON.stringify(r.body));
      return r.body.data;
    };
    let product, sibling, warehouse, category, sub;
    try {
      await sequelize.query(
        await readFile(
          new URL('../test-support/team-schema.sql', import.meta.url),
          'utf8',
        ),
      );
      await assertTeamSchemaReady();
      const admin = await models.user.create({
        realm: 'admin',
        name: 'Test',
        email: 'native@example.invalid',
        passwordHash: await bcrypt.hash('test-password', 4),
      });
      await models.adminProfile.create({ userId: admin.id, permissions: ['*'] });
      ok(
        await agent
          .post('/api/admin/auth/login')
          .set('Origin', origin)
          .send({ email: 'native@example.invalid', password: 'test-password' }),
      );
      [category] = await query(
        "INSERT INTO categories(name,slug) VALUES('Daily Living','daily-living') RETURNING id",
      );
      [sub] = await query(
        "INSERT INTO categories(name,slug,parent_id) VALUES('Diapers','diapers',:id) RETURNING id",
        { id: category.id },
      );
      const payload = (size) => ({
        product_code: `DIAPER-${size}`,
        product_name: `Diaper ${size}`,
        slug: `diaper-${size.toLowerCase()}`,
        sku: `SKU-${size}`,
        product_type: 'variable',
        product_status: 'active',
        category_id: Number(category.id),
        subcategory_id: Number(sub.id),
        mrp: 1000,
        selling_price: 900,
        product_group_code: 'DIAPER',
        details: {
          size,
          colour: 'Blue',
          short_description: 'Daily care',
          specifications: {
            Size: size,
            size: size.toLowerCase(),
            Blue: 'Blue',
            blue: 'blue',
          },
        },
      });
      await t.test(
        'native schema, atomic create, initial warehouse and same-key replay',
        async () => {
          warehouse = ok(
            await write('post', 'warehouses', {
              warehouse_code: 'MAIN',
              warehouse_name: 'Main',
              city: 'Pune',
            }),
            201,
          );
          const body = {
            ...payload('M'),
            initial_inventory: {
              warehouse_id: Number(warehouse.id),
              total_quantity: 30,
              available_quantity: 30,
              in_transit_quantity: 5,
            },
          };
          const responses = await Promise.all([
            write('post', 'products', body, 'create-m'),
            write('post', 'products', body, 'create-m'),
          ]);
          product = ok(responses[0], 201);
          assert.equal(ok(responses[1], 201).id, product.id);
          assert.equal(product.stock_quantity, 30);
          assert.equal(product.inventory.in_transit_quantity, 5);
          assert.equal((await query('SELECT count(*)::int n FROM products'))[0].n, 1);
          assert.equal(
            (
              await query(
                "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='products'",
              )
            )[0].n,
            26,
          );
          assert.equal(
            (
              await write(
                'post',
                'products',
                { ...body, product_name: 'Changed' },
                'create-m',
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await write(
                'post',
                'products',
                {
                  ...payload('BAD'),
                  initial_inventory: { warehouse_id: 999999, total_quantity: 2 },
                },
                'bad',
              )
            ).status,
            422,
          );
          assert.equal((await query('SELECT count(*)::int n FROM products'))[0].n, 1);
        },
      );
      await t.test(
        'each additional size creates exactly one independent row; edit preserves IDs',
        async () => {
          sibling = ok(await write('post', 'products', payload('L'), 'create-l'), 201);
          assert.notEqual(sibling.id, product.id);
          const edited = ok(
            await write('patch', `products/${product.id}`, {
              selling_price: 850,
              details: {
                manufacturer_name: 'Example',
                key_features: ['Soft'],
                package_contents: ['10 diapers'],
                specifications: { Size: 'M', size: 'm', Blue: 'Blue', blue: 'blue' },
              },
            }),
          );
          assert.equal(edited.id, product.id);
          assert.equal(edited.details.size, 'M');
          assert.equal(edited.details.specifications.size, 'm');
          assert.equal((await query('SELECT count(*)::int n FROM products'))[0].n, 2);
          const related = ok(
            await agent.get(`/api/admin/products/${product.id}/related`),
          );
          assert.equal(related[0].id, sibling.id);
          assert.equal(
            (await write('patch', `products/${product.id}`, { base_price: 2 })).status,
            422,
          );
          assert.equal(
            (await write('patch', `products/${product.id}`, { subcategory_id: 99999 }))
              .status,
            422,
          );
          assert.equal(
            (await write('patch', `products/${product.id}`, { mrp: 1 })).status,
            422,
          );
        },
      );
      await t.test(
        'phone contract includes root-category products, zero-stock products, and standalone variable row',
        async () => {
          const catalog = ok(await agent.get('/api/app/products/catalog'));
          assert.equal(catalog.products.length, 2);
          assert.equal(catalog.products[0].categoryId, String(category.id));
          assert.ok(catalog.products[0].categoryIds.includes(String(sub.id)));
          assert.ok(catalog.products[0].image.startsWith('http'));
          assert.equal(
            catalog.products.find((p) => p.productId === sibling.id).available,
            false,
          );
          for (const p of catalog.products) {
            for (const key of ['id', 'name', 'subtitle', 'categoryId', 'image', 'rating'])
              assert.ok(typeof p[key] === 'string' && p[key].trim());
            assert.ok(Number.isFinite(p.price) && p.price >= 0 && p.mrp >= p.price);
            assert.ok(p.images.length <= 6);
          }
          if (process.env.PHONE_CATALOG_MODEL) {
            const { validateCatalog, buildCatalog } = await import(
              process.env.PHONE_CATALOG_MODEL
            );
            assert.equal(buildCatalog(validateCatalog(catalog)).products.length, 2);
          }
          const list = await agent.get(`/api/app/products?category=${category.id}`);
          assert.equal(list.body.total, 2);
          assert.equal(
            ok(await agent.get(`/api/app/products/${product.id}`)).productId,
            product.id,
          );
          const page = await agent.get(
            '/api/admin/products?limit=1&offset=0&sort_by=product_id&sort_order=desc',
          );
          assert.equal(page.body.pagination.total, 2);
          assert.equal(page.body.pagination.hasMore, true);
          assert.equal(page.body.data[0].id, sibling.id);
        },
      );
      await t.test(
        'absolute inventory writes and reservation/purchase/return conserve stock exactly once',
        async () => {
          const body = {
            warehouse_id: Number(warehouse.id),
            total_quantity: 10,
            available_quantity: 8,
            damaged_quantity: 2,
            in_transit_quantity: 5,
          };
          ok(await write('put', `products/${sibling.id}/inventory`, body));
          assert.equal(
            ok(await write('put', `products/${sibling.id}/inventory`, body))
              .available_quantity,
            8,
          );
          await query('INSERT INTO customers(id) VALUES(gen_random_uuid())');
          await query(
            `INSERT INTO product_checkouts(id,customer_id,request_key,fingerprint,amount_paise,payload) SELECT 'NATIVE-ORDER',id,'native','native',1,'{"inventorySchema":"team-v1"}' FROM customers LIMIT 1`,
          );
          const reserve = () =>
            sequelize.transaction((tx) =>
              reserveTeamStock(
                'NATIVE-ORDER',
                [{ id: `product:${sibling.id}`, quantity: 3 }],
                tx,
              ),
            );
          await reserve();
          await reserve();
          let [stock] = await query(
            'SELECT * FROM product_inventory WHERE product_id=:id',
            { id: sibling.id },
          );
          assert.equal(stock.available_quantity, 5);
          assert.equal(stock.reserved_quantity, 3);
          assert.equal(
            (
              await write('put', `products/${sibling.id}/inventory`, {
                ...body,
                reserved_quantity: 0,
              })
            ).status,
            409,
          );
          await sequelize.transaction((tx) => settleTeamStock('NATIVE-ORDER', false, tx));
          await reserve();
          await sequelize.transaction((tx) => settleTeamStock('NATIVE-ORDER', true, tx));
          await sequelize.transaction((tx) => settleTeamStock('NATIVE-ORDER', true, tx));
          [stock] = await query('SELECT * FROM product_inventory WHERE product_id=:id', {
            id: sibling.id,
          });
          assert.equal(stock.total_quantity, 7);
          assert.equal(stock.available_quantity, 5);
          assert.equal(stock.in_transit_quantity, 5);
          await sequelize.transaction((tx) => returnTeamStock('NATIVE-ORDER', tx));
          await sequelize.transaction((tx) => returnTeamStock('NATIVE-ORDER', tx));
          [stock] = await query('SELECT * FROM product_inventory WHERE product_id=:id', {
            id: sibling.id,
          });
          assert.equal(stock.total_quantity, 10);
          assert.equal(stock.available_quantity, 8);
          assert.ok(
            ok(await agent.get(`/api/admin/products/${sibling.id}/inventory-history`))
              .length >= 4,
          );
          assert.ok(
            ok(await agent.get(`/api/admin/products/${product.id}/audit-history`))
              .length >= 2,
          );
        },
      );
      await t.test(
        'image upload/replacement retries and cleanup are safe without real S3 writes',
        async () => {
          const { s3 } = await import('../src/shared/image_upload.js');
          const calls = [];
          const send = s3.send;
          s3.send = async (c) => {
            calls.push(c.constructor.name);
            return {};
          };
          try {
            const png = await readFile(
              new URL('../src/app/products/image-unavailable.png', import.meta.url),
            );
            const upload = () =>
              agent
                .post(`/api/admin/products/${product.id}/images`)
                .set('Origin', origin)
                .set('Idempotency-Key', 'image-create')
                .attach('uploadimage', png, {
                  filename: 'test.png',
                  contentType: 'image/png',
                });
            const added = ok(await upload(), 201);
            assert.equal(ok(await upload(), 201)[0].id, added[0].id);
            assert.equal(calls.filter((c) => c === 'PutObjectCommand').length, 1);
            const replace = () =>
              agent
                .put(`/api/admin/products/${product.id}/images/${added[0].id}`)
                .set('Origin', origin)
                .set('Idempotency-Key', 'image-replace')
                .attach('uploadimage', png, {
                  filename: 'new.png',
                  contentType: 'image/png',
                });
            ok(await replace());
            ok(await replace());
            assert.equal(calls.filter((c) => c === 'PutObjectCommand').length, 2);
            ok(await agent.get(`/api/admin/products/${product.id}/images`));
            assert.equal(
              (await write('delete', `products/${product.id}/images/${added[0].id}`, {}))
                .status,
              204,
            );
            assert.equal(
              ok(await agent.get(`/api/admin/products/${product.id}/images`)).length,
              0,
            );
            assert.equal(
              (
                await agent
                  .post(`/api/admin/products/${product.id}/images`)
                  .set('Origin', origin)
                  .attach('uploadimage', Buffer.from('not png'), {
                    filename: 'bad.png',
                    contentType: 'image/png',
                  })
              ).status,
              400,
            );
          } finally {
            s3.send = send;
          }
        },
      );
      await t.test(
        'failed multi-product reservation rolls back and reset-era orders cannot touch new inventory',
        async () => {
          await query(
            `INSERT INTO product_checkouts(id,customer_id,request_key,fingerprint,amount_paise,payload) SELECT 'NATIVE-FAIL',id,'fail','fail',1,'{"inventorySchema":"team-v1"}' FROM customers LIMIT 1`,
          );
          await assert.rejects(
            sequelize.transaction((tx) =>
              reserveTeamStock(
                'NATIVE-FAIL',
                [
                  { id: `product:${product.id}`, quantity: 2 },
                  { id: `product:${sibling.id}`, quantity: 999 },
                ],
                tx,
              ),
            ),
            /Stock changed/,
          );
          assert.equal(
            (
              await query('SELECT stock_quantity FROM products WHERE id=:id', {
                id: product.id,
              })
            )[0].stock_quantity,
            30,
          );
          assert.equal(
            (
              await query(
                "SELECT count(*)::int n FROM order_stock_reservations WHERE order_id='NATIVE-FAIL'",
              )
            )[0].n,
            0,
          );
          await query(
            `INSERT INTO product_checkouts(id,customer_id,request_key,fingerprint,amount_paise,payload) SELECT 'OLD-ORDER',id,'old','old',1,'{}' FROM customers LIMIT 1`,
          );
          await assert.rejects(
            sequelize.transaction((tx) =>
              reserveTeamStock(
                'OLD-ORDER',
                [{ id: `product:${product.id}`, quantity: 1 }],
                tx,
              ),
            ),
            /predates/,
          );
        },
      );
      await t.test(
        'draft/deactivated rows remain private; taxonomy and health routes work',
        async () => {
          ok(await write('patch', `products/${sibling.id}`, { product_status: 'draft' }));
          assert.equal(
            ok(await agent.get('/api/app/products/catalog')).products.length,
            1,
          );
          ok(
            await write('patch', `products/${sibling.id}`, {
              product_status: 'active',
              is_active: false,
            }),
          );
          assert.equal(
            ok(await agent.get('/api/app/products/catalog')).products.length,
            1,
          );
          ok(await write('patch', `products/${sibling.id}`, { is_active: true }));
          assert.equal(
            ok(
              await agent.get(`/api/admin/categories?parent_category_id=${category.id}`),
            )[0].category_id,
            sub.id,
          );
          await query(
            "INSERT INTO vendors(vendor_code,name,vendor_status) VALUES('V1','Example vendor','active')",
          );
          assert.equal(
            ok(await agent.get('/api/admin/vendors'))[0].name,
            'Example vendor',
          );
          assert.equal((await agent.get('/health/ready')).status, 200);
          assert.equal((await request(app).get('/api/admin/products')).status, 401);
        },
      );
      await t.test(
        'documented full payload round-trips all detail fields and rejects oversized JSON',
        async () => {
          const example = JSON.parse(
            await readFile(
              new URL('../docs/native-catalog/create-product.json', import.meta.url),
              'utf8',
            ),
          );
          example.category_id = Number(category.id);
          example.initial_inventory.warehouse_id = Number(warehouse.id);
          const added = ok(
            await write('post', 'products', example, 'documented-example'),
            201,
          );
          const read = ok(await agent.get(`/api/admin/products/${added.id}`));
          for (const [field, value] of Object.entries(example.details)) {
            if (field === 'additional_attributes')
              assert.equal(read.details[field].Collection, value.Collection);
            else if (typeof value === 'number')
              assert.equal(Number(read.details[field]), value, field);
            else assert.deepEqual(read.details[field], value, field);
          }
          assert.equal(read.product_group_code, 'BP-MACHINE');
          assert.equal(
            (
              await write('patch', `products/${added.id}`, {
                details: { full_description: 'x'.repeat(129 * 1024) },
              })
            ).status,
            413,
          );
          assert.equal((await write('delete', `products/${added.id}`, {})).status, 204);
          assert.equal((await agent.get(`/api/admin/products/${added.id}`)).status, 404);
          assert.equal((await agent.get(`/api/app/products/${added.id}`)).status, 404);
        },
      );
      await t.test(
        'recursive category deletion archives associated listings and preserves inventory/audit',
        async () => {
          assert.equal(
            (await agent.get(`/api/admin/categories/${category.id}/deletion-preview`))
              .status,
            200,
          );
          const removed = ok(
            await write('delete', `categories/${category.id}?response=summary`, {}),
          );
          assert.equal(removed.deleted_products, 2);
          assert.equal(removed.deleted_categories, 2);
          assert.equal(
            ok(await agent.get('/api/app/products/catalog')).products.length,
            0,
          );
          assert.equal(
            (await query('SELECT count(*)::int n FROM product_inventory'))[0].n,
            3,
          );
          assert.equal(
            (await query('SELECT count(*)::int n FROM products WHERE is_deleted'))[0].n,
            3,
          );
        },
      );
    } finally {
      await sequelize.close();
    }
  },
);
