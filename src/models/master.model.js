import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

const id = { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true };
const options = { underscored: true, timestamps: true };

export const MasterState = sequelize.define(
  'MasterState',
  {
    id,
    name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  },
  { ...options, tableName: 'master_states' },
);

export const MasterCity = sequelize.define(
  'MasterCity',
  {
    id,
    stateId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
  },
  {
    ...options,
    tableName: 'master_cities',
    indexes: [{ unique: true, fields: ['state_id', 'name'] }],
  },
);

export const Faq = sequelize.define(
  'Faq',
  {
    id,
    question: { type: DataTypes.TEXT, allowNull: false, unique: true },
    answer: { type: DataTypes.TEXT, allowNull: false },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...options, tableName: 'faqs' },
);
