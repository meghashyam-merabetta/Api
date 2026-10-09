import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const Lab = sequelize.define(
  'Lab',
  {
    // Preserve app catalog IDs so test/offering references continue matching.
    id: { type: DataTypes.STRING(100), primaryKey: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false },
    rating: { type: DataTypes.DECIMAL(2, 1), allowNull: false },
    image: { type: DataTypes.STRING(500), allowNull: false },
    color: { type: DataTypes.STRING(7), allowNull: false },
    bg: { type: DataTypes.STRING(7), allowNull: false },
    active: { type: DataTypes.BOOLEAN, defaultValue: true, allowNull: false },
    city: { type: DataTypes.STRING(100), allowNull: false },
    homeCollection: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
  },
  { tableName: 'labs', underscored: true, timestamps: true },
);
