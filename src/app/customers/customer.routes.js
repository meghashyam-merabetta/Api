import * as schema from './customer.schema.js';
import * as controller from './customer.controller.js';

// Authentication is mandatory unless a route explicitly sets auth: false.
export const customerRoutes = [
  { method: 'get', path: '/me', auth: true, handler: controller.getProfile },
  {
    method: 'put',
    path: '/me/profile',
    auth: true,
    schema: schema.updateProfileSchema,
    handler: controller.updateProfile,
  },
  { method: 'delete', path: '/me', auth: true, handler: controller.deleteAccount },
  { method: 'get', path: '/me/addresses', auth: true, handler: controller.listAddresses },
  {
    method: 'post',
    path: '/me/addresses',
    auth: true,
    schema: schema.addressSchema,
    handler: controller.addAddress,
  },
  {
    method: 'put',
    path: '/me/addresses/:id',
    auth: true,
    params: schema.recordIdSchema,
    schema: schema.addressSchema,
    handler: controller.updateAddress,
  },
  {
    method: 'delete',
    path: '/me/addresses/:id',
    auth: true,
    params: schema.recordIdSchema,
    handler: controller.deleteAddress,
  },
  {
    method: 'get',
    path: '/me/family-members',
    auth: true,
    handler: controller.listFamilyMembers,
  },
  {
    method: 'post',
    path: '/me/family-members',
    auth: true,
    schema: schema.familyMemberSchema,
    handler: controller.addFamilyMember,
  },
  {
    method: 'put',
    path: '/me/family-members/:id',
    auth: true,
    params: schema.recordIdSchema,
    schema: schema.familyMemberSchema,
    handler: controller.updateFamilyMember,
  },
  {
    method: 'delete',
    path: '/me/family-members/:id',
    auth: true,
    params: schema.recordIdSchema,
    handler: controller.deleteFamilyMember,
  },
];
