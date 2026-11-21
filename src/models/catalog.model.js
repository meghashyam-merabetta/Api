import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { defineProductVariant } from './product-variant.model.js';
const options = {
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};
const id = { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true };
export const Brand = sequelize.define(
  'Brand',
  {
    brand_id: { ...id, field: 'id' },
    brand_name: { type: DataTypes.STRING(150), field: 'name', allowNull: false },
    slug: { type: DataTypes.STRING(180), allowNull: false },
    description: DataTypes.TEXT,
    image_url: { type: DataTypes.TEXT, field: 'logo_url' },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true, allowNull: false },
  },
  { ...options, tableName: 'brands' },
);
export const VariantAttribute = sequelize.define(
  'VariantAttribute',
  {
    id,
    name: { type: DataTypes.STRING(100), allowNull: false },
    values: { type: DataTypes.JSONB, allowNull: false },
  },
  { ...options, tableName: 'product_variant_attributes' },
);
export const ProductVariant = defineProductVariant(sequelize);
// Phase 3 must never resolve the historical table through search_path.
// Leave the legacy model binding unchanged for existing callers.
export const PublicProductVariant = ProductVariant.schema('public');
