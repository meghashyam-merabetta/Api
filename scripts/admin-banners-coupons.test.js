import test from 'node:test';
import assert from 'node:assert/strict';
import { bannerRoutes } from '../src/admin/banners/banners.routes.js';
import { couponRoutes } from '../src/admin/coupons/coupons.routes.js';
import {
  createBannerSchema,
  batchBannerMetadataSchema,
  listBannersQuerySchema,
  updateBannerSchema,
} from '../src/admin/banners/banners.schema.js';
import {
  createCouponSchema,
  listCouponsQuerySchema,
  updateCouponSchema,
} from '../src/admin/coupons/coupons.schema.js';
import { imageUrl, managedImageKeyFromUrl } from '../src/shared/image-storage.js';
import { nextBannerKey } from '../src/admin/banners/banners.controller.js';

test('admin banner contract validates database fields and publication windows', () => {
  const banner = createBannerSchema.parse({
    banner_key: 'home-offer',
    page_name: 'Home',
    banner_name: 'Offer',
    image_path: '/images/offer.png',
    width_px: 1774,
    height_px: 887,
    status: 'DRAFT',
    publish_start_at: '2026-11-11T10:00:00+05:30',
    publish_end_at: '2026-11-12T10:00:00+05:30',
  });
  assert.equal(banner.banner_key, 'home-offer');
  assert.throws(() => createBannerSchema.parse({ ...banner, width_px: 0 }));
  assert.throws(() => updateBannerSchema.parse({}));
  assert.throws(() =>
    updateBannerSchema.parse({
      publish_start_at: '2026-11-12T10:00:00+05:30',
      publish_end_at: '2026-11-11T10:00:00+05:30',
    }),
  );
  assert.deepEqual(listBannersQuerySchema.parse({}), {
    limit: 20,
    offset: 0,
    sort_by: 'display_order',
    sort_order: 'asc',
  });
  assert.equal(bannerRoutes.filter((route) => route.path.includes('image')).length, 5);
  assert.equal(
    bannerRoutes.some((route) => route.path === '/batch'),
    true,
  );
  assert.equal(
    batchBannerMetadataSchema.parse({
      banner_key: 'home-labs',
      page_name: 'Home',
      banner_name: 'Labs campaign',
      is_active: true,
      images: [
        { width_px: 1200, height_px: 400 },
        { width_px: 1200, height_px: 400 },
      ],
    }).images.length,
    2,
  );
});

test('admin coupon contract matches app scope, percent, paise, and date rules', () => {
  const coupon = createCouponSchema.parse({
    code: ' save_10 ',
    scope: 'both',
    percent: 10.25,
    max_discount_paise: 10000,
    starts_at: '2026-11-11T10:00:00+05:30',
  });
  assert.equal(coupon.code, 'SAVE_10');
  assert.throws(() => createCouponSchema.parse({ ...coupon, scope: 'website' }));
  assert.throws(() => createCouponSchema.parse({ ...coupon, percent: 100.01 }));
  assert.throws(() => createCouponSchema.parse({ ...coupon, max_discount_paise: 0 }));
  assert.throws(() => updateCouponSchema.parse({}));
  assert.deepEqual(listCouponsQuerySchema.parse({}), { limit: 20, offset: 0 });
  assert.equal(couponRoutes.length, 5);
});

test('shared managed-image policy includes banner object keys', () => {
  const key = 'upload/banners/17/12345678-1234-1234-1234-123456789abc.webp';
  assert.equal(managedImageKeyFromUrl(imageUrl(key)), key);
});

test('banner placement keys allocate stable count suffixes', () => {
  assert.equal(nextBannerKey('home-labs', []), 'home-labs');
  assert.equal(nextBannerKey('home-labs', ['home-labs']), 'home-labs-02');
  assert.equal(
    nextBannerKey('home-labs', [
      'home-labs',
      'home-labs-02',
      'home-labs-04',
      'home-labs-old',
    ]),
    'home-labs-05',
  );
  assert.equal(
    nextBannerKey('home-labs', ['home-labs-02']),
    'home-labs',
    'the exact app key is reused when it was deleted',
  );
});
