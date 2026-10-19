
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const Product = sequelize.define(
  'Product',
  {
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
