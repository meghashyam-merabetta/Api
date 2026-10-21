export { User } from './user.model.js';
export { Session } from './session.model.js';

import { ProductImage } from './product-image.model.js';

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
import { Faq, MasterState, MasterCity } from './master.model.js';
import { Lab } from './lab.model.js';
import { AdminProfile } from './admin.model.js';
import { Product } from './product.model.js';
import { Category } from './category.model.js';
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
  product: Product, 
  category: Category,
  productCategory: ProductCategory,
  productImage: ProductImage,
};

Product.belongsToMany(Category, {
  through: ProductCategory,
  foreignKey: 'product_id',
  otherKey: 'category_id',
  as: 'categories',
});

Category.belongsToMany(Product, {
  through: ProductCategory,
  foreignKey: 'category_id',
  otherKey: 'product_id',
  as: 'products',
});

Category.belongsTo(Category, {
  foreignKey: 'parent_category_id',
  as: 'parent',
});

Category.hasMany(Category, {
  foreignKey: 'parent_category_id',
  as: 'subcategories',
});

Product.hasMany(ProductImage, {
  foreignKey: 'product_id',
  as: 'images',
  onDelete: 'CASCADE',
});

ProductImage.belongsTo(Product, {
  foreignKey: 'product_id',
  as: 'product',
});