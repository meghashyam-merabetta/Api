import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
export const ProductCatalog = sequelize.define(
  'ProductCatalog',
  {
    id: { type: DataTypes.STRING(100), primaryKey: true },
    data: { type: DataTypes.JSONB, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { tableName: 'product_catalog', timestamps: false },
);
export const ProductOrderCounter = sequelize.define(
  'ProductOrderCounter',
  {
    order_day: { type: DataTypes.DATEONLY, primaryKey: true },
    last_number: { type: DataTypes.INTEGER, allowNull: false },
  },
  { tableName: 'product_order_counters', timestamps: false },
);
export const ProductCheckout = sequelize.define(
  'ProductCheckout',
  {
    id: { type: DataTypes.STRING(20), primaryKey: true },
    customer_id: { type: DataTypes.UUID, allowNull: false },
    request_key: { type: DataTypes.STRING(100), allowNull: false },
    fingerprint: { type: DataTypes.STRING(64), allowNull: false },
    amount_paise: { type: DataTypes.BIGINT, allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'INR' },
    payment_status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'NEW' },
    session_state: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'created',
    },
    payment_url: DataTypes.TEXT,
    payment_expiry: DataTypes.DATE,
    payload: { type: DataTypes.JSONB, allowNull: false },
    transaction_id: DataTypes.TEXT,
    last_error: DataTypes.TEXT,
    stock_state: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'legacy' },
    payment_checked_at: DataTypes.DATE,
    order_number: DataTypes.STRING(13),
  },
  {
    tableName: 'product_checkouts',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);
