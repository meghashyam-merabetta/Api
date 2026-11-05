import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

// Migrations own these tables and append-only triggers. Normal APIs only read history.
export const Inventory = sequelize.define(
  'Inventory',
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    product_id: DataTypes.BIGINT,
    vendor_product_id: DataTypes.BIGINT,
    warehouse_code: DataTypes.STRING(100),
    quantity_on_hand: DataTypes.INTEGER,
    quantity_reserved: DataTypes.INTEGER,
    updated_by: DataTypes.UUID,
    updated_at: DataTypes.DATE,
  },
  { tableName: 'inventory', timestamps: false },
);
export const AuditLog = sequelize.define(
  'AuditLog',
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    entity_type: DataTypes.TEXT,
    entity_id: DataTypes.TEXT,
    action: DataTypes.TEXT,
    old_values: DataTypes.JSONB,
    new_values: DataTypes.JSONB,
    changed_fields: DataTypes.ARRAY(DataTypes.TEXT),
    changed_by: DataTypes.UUID,
    actor_type: DataTypes.TEXT,
    changed_at: DataTypes.DATE,
    request_id: DataTypes.TEXT,
    reason: DataTypes.TEXT,
  },
  { tableName: 'audit_logs', timestamps: false },
);
export const StockMovement = sequelize.define(
  'StockMovement',
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    product_id: DataTypes.BIGINT,
    inventory_id: DataTypes.BIGINT,
    warehouse_code: DataTypes.TEXT,
    quantity_before: DataTypes.INTEGER,
    quantity_changed: DataTypes.INTEGER,
    quantity_after: DataTypes.INTEGER,
    on_hand_before: DataTypes.INTEGER,
    on_hand_after: DataTypes.INTEGER,
    reserved_before: DataTypes.INTEGER,
    reserved_after: DataTypes.INTEGER,
    movement_type: DataTypes.TEXT,
    changed_by: DataTypes.UUID,
    actor_type: DataTypes.TEXT,
    order_id: DataTypes.TEXT,
    reason: DataTypes.TEXT,
    request_id: DataTypes.TEXT,
    changed_at: DataTypes.DATE,
  },
  { tableName: 'stock_movements', timestamps: false },
);
