import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    realm: {
      type: DataTypes.STRING(10),
      allowNull: false,
      validate: { isIn: [['app', 'admin']] },
    },
    name: { type: DataTypes.STRING(100), allowNull: false },
    email: { type: DataTypes.STRING(254), allowNull: false },
    passwordHash: { type: DataTypes.STRING, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: 'users',
    defaultScope: { attributes: { exclude: ['passwordHash'] } },
    indexes: [{ unique: true, fields: ['realm', 'email'] }],
  },
);
