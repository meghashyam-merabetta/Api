import test from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../src/config/database.js';
import {
  getOldAgeHome,
  listOldAgeHomes,
  serializePublicOldAgeHome,
} from '../src/app/old-age-homes/old-age-homes.controller.js';
import { oldAgeHomeRoutes } from '../src/app/old-age-homes/old-age-homes.routes.js';

const row = {
  id: '2e5ff950-94fd-4755-abde-8712be467e19',
  home_name: 'Shantiban Old Age Home',
  year_established: 2011,
  organization_type: 'Private',
  address: 'Wakad',
  city: 'Pune',
  state: 'Maharashtra',
  pin_code: '411057',
  website: null,
  total_capacity: 40,
  current_residents: 13,
  medical_facilities: null,
  services_offered: { assistedLiving: true },
  facility_pricing: { assistedLiving: { from: 15000, to: 20000 } },
  facility_photographs: null,
  facility_video: null,
};

const response = () => ({
  body: null,
  json(value) {
    this.body = value;
    return this;
  },
});

test('public old age home shape is null-safe and excludes private enrollment data', () => {
  const home = serializePublicOldAgeHome(row);
  assert.equal(home.name, row.home_name);
  assert.equal(home.availableCapacity, 27);
  assert.deepEqual(home.images, []);
  assert.deepEqual(home.medicalFacilities, {});
  assert.equal('contactPersonName' in home, false);
  assert.equal('registrationCertificate' in home, false);
});

test('public old age home routes mirror product list, catalog and detail contracts', () => {
  assert.deepEqual(
    oldAgeHomeRoutes.map(({ method, path, auth }) => [method, path, auth]),
    [
      ['get', '/catalog', false],
      ['get', '/', false],
      ['get', '/:id', false],
    ],
  );
});

test('list query always requires active, non-deleted joined records', async () => {
  const original = sequelize.query;
  let sql;
  sequelize.query = async (query) => {
    sql = query;
    return [{ ...row, total: 1 }];
  };
  try {
    const res = response();
    await listOldAgeHomes(
      {
        validatedQuery: {
          limit: 20,
          offset: 0,
          city: 'Pune',
          state: undefined,
          service: 'assistedLiving',
          q: undefined,
        },
      },
      res,
    );
    assert.match(sql, /c\.status = 'ACTIVE'/);
    assert.match(sql, /a\.status = 'ACTIVE'/);
    assert.match(sql, /a\.deleted_at IS NULL/);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.data.length, 1);
  } finally {
    sequelize.query = original;
  }
});

test('detail lookup never returns an inactive or deleted enrollment', async () => {
  const original = sequelize.query;
  let sql;
  sequelize.query = async (query) => {
    sql = query;
    return [row];
  };
  try {
    const res = response();
    await getOldAgeHome(
      { validatedParams: { id: row.id } },
      res,
    );
    assert.match(sql, /c\.status = 'ACTIVE'/);
    assert.match(sql, /a\.status = 'ACTIVE'/);
    assert.match(sql, /a\.deleted_at IS NULL/);
    assert.equal(res.body.data.id, row.id);
  } finally {
    sequelize.query = original;
  }
});
