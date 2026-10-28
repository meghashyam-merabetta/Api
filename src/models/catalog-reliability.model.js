import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const ProductImageCleanup = sequelize.define(
  'ProductImageCleanup',
  {
    s3_key: { type: DataTypes.TEXT, primaryKey: true },
    not_before: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_error: DataTypes.TEXT,
  },
  {
    tableName: 'product_image_cleanup',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  },
);

export const AdminCatalogRequest = sequelize.define(
  'AdminCatalogRequest',
  {
    id: { type: DataTypes.STRING(64), primaryKey: true },
    fingerprint: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.INTEGER, allowNull: false },
    body: { type: DataTypes.JSONB, allowNull: false },
  },
  {
    tableName: 'admin_catalog_requests',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  },
);
