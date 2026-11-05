import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const ProductCategory = sequelize.define(
  'ProductCategory',
  {
    created_at: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW },
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
    product_id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      allowNull: false,
    },
    category_id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      allowNull: false,
    },
    is_primary: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: 'product_categories',
    timestamps: false,
    underscored: true,
  },
);
