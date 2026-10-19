
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const ProductCategory = sequelize.define(
  'ProductCategory',
  {
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
