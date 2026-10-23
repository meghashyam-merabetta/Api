import { contactRoutes } from '../app/contact/routes.js';
import { bannerRoutes } from '../app/banners/routes.js';
import { couponRoutes } from '../app/coupons/routes.js';
import { bookingRoutes } from '../app/bookings/bookings.routes.js';
import { orderRoutes } from '../app/orders/orders.routes.js';
import { redcliffeRoutes } from '../app/redcliffe-labs/routes.js';
import { locationRoutes } from '../app/locations/locations.routes.js';
import { Router } from 'express';
import { buildRouter } from '../shared/routes.js';
import { authenticateCustomer } from '../shared/customer-session.js';
import { adminAuth } from '../admin/auth/auth.controller.js';
import { authRoutes as customerAuth } from '../app/auth/auth.routes.js';
import { customerRoutes } from '../app/customers/customer.routes.js';
import { productRoutes } from '../app/products/products.routes.js';
import { cartRoutes } from '../app/cart/cart.routes.js';
import { wishlistRoutes } from '../app/wishlist/wishlist.routes.js';
import { masterRoutes } from '../app/masters/master.routes.js';
import { authRoutes as adminAuthRoutes } from '../admin/auth/auth.routes.js';
import { productsRoutes as adminProducts } from '../admin/products/products.routes.js';
import { categoriesRoutes as adminCategories } from '../admin/categories/categories.routes.js';
import { userRoutes as adminUsers } from '../admin/users/users.routes.js';
import { adminManagementRoutes } from '../admin/management/admin.routes.js';
import { labRoutes } from '../app/labs/lab.routes.js';
import { orderingRoutes } from '../admin/ordering/ordering.routes.js';
import { getSettings, updateSettings, settingsSchema } from '../app/pricing/settings.js';

// Register new modules here. Realm chooses authentication centrally.
const modules = [
  { path: '/app', realm: 'app', routes: [{ method: 'get', path: '/pricing-settings', auth: false, handler: getSettings }] },
  { path: '/admin/pricing-settings', realm: 'admin', routes: [
    { method: 'get', path: '/', handler: getSettings },
    { method: 'patch', path: '/', schema: settingsSchema, handler: updateSettings },
  ] },
  { path: '/admin/ordering', realm: 'admin', routes: orderingRoutes },
  { path: '/app', realm: 'app', routes: bannerRoutes },
  { path: '/app', realm: 'app', routes: contactRoutes },
  { path: '/app', realm: 'app', routes: couponRoutes },
  { path: '/app', realm: 'app', routes: orderRoutes },
  { path: '/app/redcliffe', realm: 'app', routes: redcliffeRoutes },
  { path: '/app/locations', realm: 'app', routes: locationRoutes },
  { path: '/app', realm: 'app', routes: bookingRoutes },
  { path: '/app/labs', realm: 'app', routes: labRoutes },
  { path: '/app/auth', realm: 'app', routes: customerAuth },
  { path: '/app/customers', realm: 'app', routes: customerRoutes },
  { path: '/app/products', realm: 'app', routes: productRoutes },
  { path: '/app/cart', realm: 'app', routes: cartRoutes },
  { path: '/app/wishlist', realm: 'app', routes: wishlistRoutes },
  { path: '/app', realm: 'app', routes: masterRoutes },
  { path: '/admin/auth', realm: 'admin', routes: adminAuthRoutes },
  { path: '/admin/products', realm: 'admin', routes: adminProducts },
  { path: '/admin/categories', realm: 'admin', routes: adminCategories },
  { path: '/admin/users', realm: 'admin', routes: adminUsers },
  { path: '/admin/management', realm: 'admin', routes: adminManagementRoutes },
];

const authentication = { app: authenticateCustomer, admin: adminAuth.authenticate };
export const apiRoutes = Router();

for (const module of modules) {
  const authenticate = authentication[module.realm];
  if (!authenticate) throw new Error('Unknown route realm: ' + module.realm);
  apiRoutes.use(module.path, buildRouter(authenticate, module.routes));
}
