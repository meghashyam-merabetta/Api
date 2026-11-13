import {
  createBanner,
  createBannerBatch,
  deleteBanner,
  deleteBannerMobileImage,
  getBanner,
  listBanners,
  updateBanner,
  uploadBannerImage,
  uploadBannerMobileImage,
} from './banners.controller.js';
import {
  bannerKeyParamsSchema,
  createBannerSchema,
  listBannersQuerySchema,
  updateBannerSchema,
} from './banners.schema.js';

export const bannerRoutes = [
  { method: 'post', path: '/batch', handler: createBannerBatch },
  { method: 'get', path: '/', query: listBannersQuerySchema, handler: listBanners },
  { method: 'post', path: '/', schema: createBannerSchema, handler: createBanner },
  {
    method: 'get',
    path: '/:bannerKey',
    params: bannerKeyParamsSchema,
    handler: getBanner,
  },
  {
    method: 'patch',
    path: '/:bannerKey',
    params: bannerKeyParamsSchema,
    schema: updateBannerSchema,
    handler: updateBanner,
  },
  {
    method: 'delete',
    path: '/:bannerKey',
    params: bannerKeyParamsSchema,
    handler: deleteBanner,
  },
  {
    method: 'post',
    path: '/:bannerKey/image',
    params: bannerKeyParamsSchema,
    handler: uploadBannerImage,
  },
  {
    method: 'put',
    path: '/:bannerKey/image',
    params: bannerKeyParamsSchema,
    handler: uploadBannerImage,
  },
  {
    method: 'post',
    path: '/:bannerKey/mobile-image',
    params: bannerKeyParamsSchema,
    handler: uploadBannerMobileImage,
  },
  {
    method: 'put',
    path: '/:bannerKey/mobile-image',
    params: bannerKeyParamsSchema,
    handler: uploadBannerMobileImage,
  },
  {
    method: 'delete',
    path: '/:bannerKey/mobile-image',
    params: bannerKeyParamsSchema,
    handler: deleteBannerMobileImage,
  },
];
