import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { effectivePrice } from '../shared/catalog-fields.js';

export const Product = sequelize.define(
  'Product',
  {
    product_code: { type: DataTypes.STRING(100), allowNull: true },
    sku: { type: DataTypes.STRING(100), allowNull: true },
    product_type: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'simple',
    },
    regular_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    sale_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    offer_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    special_discount_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    special_discount_percent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0,
    },
    festival_offer_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    festival_offer_percent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0,
    },
    stock_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    min_order_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    max_order_quantity: { type: DataTypes.INTEGER, allowNull: true },
    target_audience: { type: DataTypes.TEXT, allowNull: true },
    hsn_code: { type: DataTypes.STRING(20), allowNull: true },
    gst_rate: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    weight: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
    weight_unit: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'g' },
    unit_count: { type: DataTypes.INTEGER, allowNull: true },
    package_length: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
    package_breadth: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
    package_height: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
    dimension_unit: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'cm' },
    material: { type: DataTypes.TEXT, allowNull: true },
    colour: { type: DataTypes.TEXT, allowNull: true },
    package_type: { type: DataTypes.TEXT, allowNull: true },
    shelf_life: { type: DataTypes.TEXT, allowNull: true },
    water_resistant: { type: DataTypes.BOOLEAN, allowNull: true },
    hazardous_clause: { type: DataTypes.TEXT, allowNull: true },
    manufactured_in: { type: DataTypes.TEXT, allowNull: true },
    company_name: { type: DataTypes.TEXT, allowNull: true },
    company_address: { type: DataTypes.TEXT, allowNull: true },
    packer_name: { type: DataTypes.TEXT, allowNull: true },
    packer_address: { type: DataTypes.TEXT, allowNull: true },
    keywords: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    effective_price: {
      type: DataTypes.VIRTUAL,
      get() {
        return effectivePrice(this.dataValues);
      },
    },
    product_id: {
      type: DataTypes.BIGINT,
      field: 'id',
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    product_name: {
      type: DataTypes.STRING(255),
      field: 'name',
      allowNull: false,
      validate: { notEmpty: true },
    },
    brand_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    slug: {
      type: DataTypes.STRING(280),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    short_description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    product_status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'draft',
      validate: {
        isIn: [['draft', 'active', 'inactive', 'archived']],
      },
    },
  },
  {
    tableName: 'products',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);
