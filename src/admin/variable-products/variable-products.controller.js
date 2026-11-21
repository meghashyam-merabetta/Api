import { sequelize } from '../../config/database.js';
import { Product } from '../../models/product.model.js';
import { PublicProductVariant, VariantAttribute } from '../../models/catalog.model.js';
import { audit, validateReferences } from '../../catalog/store.js';
import {
  productValues,
  saveDetails,
  getFullProduct,
} from '../products/products.controller.js';
import { createVariableProductHandlers } from './variable-products.service.js';

export const variableProductHandlers = createVariableProductHandlers({
  sequelize,
  Product: Product.schema('public'),
  ProductVariant: PublicProductVariant,
  VariantAttribute: VariantAttribute.schema('public'),
  productValues,
  saveDetails,
  getFullProduct,
  validateReferences,
  audit,
});
