
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

// One row in products = one independent purchasable variant.
// The PostgreSQL primary key is products.id.

export const Product = sequelize.define(
  'Product',
  {
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },

    product_code: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
    },

    product_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },

    slug: {
      type: DataTypes.STRING(300),
      allowNull: false,
      unique: true,
    },

    sku: {
      type: DataTypes.STRING(100),
      allowNull: true,
      unique: true,
    },

    barcode: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },

    brand_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    category_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    subcategory_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    vendor_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    product_type: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: 'simple',
    },

    product_status: {
      type: DataTypes.STRING(30),
      allowNull: true,
      defaultValue: 'draft',
    },

    selling_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0,
    },

    mrp: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0,
    },

    cost_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0,
    },

    tax_rate: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      defaultValue: 0,
    },

    hsn_code: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },

    stock_quantity: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },

    min_stock_quantity: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },

    is_featured: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },

    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true,
    },

    is_deleted: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },

    // PostgreSQL uses BIGINT here, not UUID.
    // Auth UUIDs must not be inserted into these fields.
    created_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    updated_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
  },
  {
    tableName: 'products',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',

    // The database uses is_deleted, not deleted_at.
    paranoid: false,
  },
);
