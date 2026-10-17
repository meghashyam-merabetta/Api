import { readFileSync } from 'node:fs';
import { sequelize } from '../src/config/database.js';
import { seedMasters } from './seed-masters.js';
import { Lab } from '../src/models/lab.model.js';
import { User } from '../src/models/user.model.js';
import { Session } from '../src/models/session.model.js';
try {
  await sequelize.transaction(async transaction => {
    await sequelize.query("SELECT pg_advisory_xact_lock(771209)", { transaction });
    // Create missing authentication tables without altering existing tables.
    await User.sync({ transaction });
    await Session.sync({ transaction });
    await sequelize.query(readFileSync(new URL('../sql/001-customers.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/002-masters.sql', import.meta.url), 'utf8'), { transaction });
    await seedMasters(transaction);
    await sequelize.query(readFileSync(new URL('../sql/003-customer-session-lifetime.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/004-labs.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/005-family-member-details.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/006-family-member-birthdate.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/007-lab-bookings.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/008-location-address.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/009-address-coordinates.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/005-admin-management.sql', import.meta.url), 'utf8'), { transaction });
    const labs = JSON.parse(readFileSync(new URL('../seed/labs.json', import.meta.url), 'utf8'));
    await Lab.bulkCreate(labs, { ignoreDuplicates: true, transaction });
    await sequelize.query(readFileSync(new URL('../sql/010-app-registration-and-lab-master.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/011-redcliffe-integration.sql', import.meta.url), 'utf8'), { transaction });
    await sequelize.query(readFileSync(new URL('../sql/012-third-party-api-logs.sql', import.meta.url), 'utf8'), { transaction });
  });
  await sequelize.query(readFileSync(new URL('../sql/013-lab-booking-amendment.sql', import.meta.url), 'utf8'));
  await sequelize.query(readFileSync(new URL('../sql/014-product-orders.sql', import.meta.url), 'utf8'));
  for (const product of JSON.parse(readFileSync(new URL('../seed/products.json', import.meta.url), 'utf8'))) await sequelize.query('INSERT INTO product_catalog(id,data) VALUES(:id,CAST(:data AS jsonb)) ON CONFLICT(id) DO NOTHING', { replacements: {id: product.id, data: JSON.stringify(product)} });
  await sequelize.query(readFileSync(new URL('../sql/015-stpl-otp.sql', import.meta.url), 'utf8'));
  await sequelize.query(readFileSync(new URL('../sql/016-cart-wishlist.sql', import.meta.url), 'utf8'));
  await sequelize.query(readFileSync(new URL('../sql/018-contact-coupons.sql', import.meta.url), 'utf8'));
  console.log('Customer schema ready.');
  await sequelize.query(readFileSync(new URL('../sql/017-catalog-sync.sql', import.meta.url), 'utf8'));
} finally { await sequelize.close(); }
