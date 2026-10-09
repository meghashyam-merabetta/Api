import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { User } from './user.model.js';

export const AdminProfile = sequelize.define(
  'AdminProfile',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    city: { type: DataTypes.STRING(100), allowNull: true },
    pincode: { type: DataTypes.STRING(6), allowNull: true },
    state: { type: DataTypes.STRING(100), allowNull: true },
    requireSuperAdminApproval: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    permissions: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
  },
  {
    tableName: 'admin_profiles',
    underscored: true,
    timestamps: true,
    indexes: [{ unique: true, fields: ['user_id'] }],
  },
);

AdminProfile.belongsTo(User, {
  as: 'user',
  foreignKey: 'userId',
});

User.hasOne(AdminProfile, {
  as: 'adminProfile',
  foreignKey: 'userId',
});
