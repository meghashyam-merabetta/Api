import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const Session = sequelize.define(
  'Session',
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    realm: {
      type: DataTypes.STRING(10),
      allowNull: false,
      validate: { isIn: [['app', 'admin']] },
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: 'sessions' },
);
