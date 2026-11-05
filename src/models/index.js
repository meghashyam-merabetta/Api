
import {
  ProductCatalog,
  ProductCheckout,
  ProductOrderCounter,
} from './product-checkout.model.js';

export { User } from './user.model.js';
export { Session } from './session.model.js';

import { ProductImage } from './product-image.model.js';
import { Brand } from './catalog.model.js';

import { User } from './user.model.js';
import { Session } from './session.model.js';

import {
  Customer,
  CustomerIdentity,
  CustomerOtpChallenge,
  CustomerLoginLog,
  CustomerAddress,
  CustomerFamilyMember,
} from './customer.model.js';

import {
  Faq,
  MasterState,
  MasterCity,
} from './master.model.js';

import { Lab } from './lab.model.js';
import { AdminProfile } from './admin.model.js';
import { Product } from './product.model.js';
import { Category } from './category.model.js';

// Retained temporarily for legacy code compatibility.
// New products store category_id and subcategory_id directly.
import { ProductCategory } from './product-category.model.js';

export const models = {
  lab: Lab,
  user: User,
  session: Session,

  customer: Customer,
  customerIdentity: CustomerIdentity,
  customerOtpChallenge: CustomerOtpChallenge,
  customerLoginLog: CustomerLoginLog,
  customerAddress: CustomerAddress,
  customerFamilyMember: CustomerFamilyMember,

  faq: Faq,
  masterState: MasterState,
  masterCity: MasterCity,

  adminProfile: AdminProfile,

  productCatalog: ProductCatalog,
  productCheckout: ProductCheckout,
  productOrderCounter: ProductOrderCounter,

  product: Product,
  productImage: ProductImage,

  category: Category,
  productCategory: ProductCategory,

  brand: Brand,
};

// ========================================
// CATEGORY PARENT / CHILD RELATIONSHIPS
// ========================================

// categories.parent_id references categories.id.

Category.belongsTo(Category, {
  foreignKey: 'parent_category_id',
  as: 'parent',
});

Category.hasMany(Category, {
  foreignKey: 'parent_category_id',
  as: 'subcategories',
});

// ========================================
// PRODUCT CATEGORY RELATIONSHIPS
// ========================================

// Both category_id and subcategory_id refer to
// the same categories master table.

Product.belongsTo(Category, {
  foreignKey: 'category_id',
  as: 'category',
});

Product.belongsTo(Category, {
  foreignKey: 'subcategory_id',
  as: 'subcategory',
});

Category.hasMany(Product, {
  foreignKey: 'category_id',
  as: 'directProducts',
});

Category.hasMany(Product, {
  foreignKey: 'subcategory_id',
  as: 'subcategoryProducts',
});

// ========================================
// PRODUCT IMAGES
// ========================================

// Product.id -> ProductImage.product_id

Product.hasMany(ProductImage, {
  foreignKey: 'product_id',
  as: 'images',
});

ProductImage.belongsTo(Product, {
  foreignKey: 'product_id',
  as: 'product',
});

// ========================================
// PRODUCT BRAND
// ========================================

Product.belongsTo(Brand, {
  foreignKey: 'brand_id',
  as: 'brand',
});

Brand.hasMany(Product, {
  foreignKey: 'brand_id',
  as: 'products',
});

// ========================================
// CUSTOMER CHECKOUTS
// ========================================

ProductCheckout.belongsTo(Customer, {
  foreignKey: 'customer_id',
  as: 'customer',
});

Customer.hasMany(ProductCheckout, {
  foreignKey: 'customer_id',
  as: 'productCheckouts',
});

export { Product, Category, Brand };

export {
  ProductCatalog,
  ProductCheckout,
  ProductOrderCounter,
};
