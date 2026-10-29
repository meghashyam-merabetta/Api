import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
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
export const ProductVariant = sequelize.define(
  'ProductVariant',
  {
    id,
    product_id: { type: DataTypes.BIGINT, allowNull: false },
    sku: { type: DataTypes.STRING(100), allowNull: false },
    variant_name: DataTypes.STRING(200),
    barcode: DataTypes.STRING(100),
    weight_grams: DataTypes.INTEGER,
    attributes: { type: DataTypes.JSONB, allowNull: false },
    regular_price: DataTypes.DECIMAL(12, 2),
    sale_price: DataTypes.DECIMAL(12, 2),
    stock_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    display_name: {
      type: DataTypes.VIRTUAL,
      get() {
        return (
          this.getDataValue('variant_name') ||
          Object.values(this.getDataValue('attributes') ?? {}).join(' / ')
        );
      },
    },
  },
  { ...options, paranoid: true, deletedAt: 'deleted_at', tableName: 'product_variants' },
);
