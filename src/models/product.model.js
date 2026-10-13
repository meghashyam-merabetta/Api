
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const Product = sequelize.define(
  'Product',
  {
    product_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      allowNull: false,
      autoIncrement: true,
    },

    product_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },

    prescription_required: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    age_group: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },

    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    category_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'categories',
        key: 'category_id',
      },
    },
  },
  {
    tableName: 'products',
    timestamps: true,
    underscored: true,
  },
);