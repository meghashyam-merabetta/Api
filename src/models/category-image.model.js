
import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const CategoryImage = sequelize.define(
  'CategoryImage',
  {
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    category_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    image_url: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    s3_key: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
    },
    alt_text: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    sort_order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    is_primary: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: 'category_images',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    underscored: true,
  },
);
