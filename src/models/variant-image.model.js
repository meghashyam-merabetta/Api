import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
export const VariantImage = sequelize.define(
  'VariantImage',
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    variant_id: { type: DataTypes.BIGINT, allowNull: false },
    image_url: { type: DataTypes.TEXT, allowNull: false },
    s3_key: { type: DataTypes.TEXT, allowNull: false },
    alt_text: DataTypes.STRING(255),
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_primary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: 'product_variant_images',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  },
);
