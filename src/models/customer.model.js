import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

const uuid = () => ({
  type: DataTypes.UUID,
  defaultValue: DataTypes.UUIDV4,
  primaryKey: true,
});
const customerId = () => ({ type: DataTypes.UUID, allowNull: false });
const softDeleteOptions = {
  underscored: true,
  timestamps: true,
  paranoid: true,
};

export const Customer = sequelize.define(
  'Customer',
  {
    id: uuid(),
    firstName: DataTypes.STRING(100),
    lastName: DataTypes.STRING(100),
    phone: DataTypes.STRING(10),
    email: DataTypes.STRING(254),
    dateOfBirth: DataTypes.DATEONLY,
    gender: DataTypes.STRING(30),
    profileCompleted: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
    isAppRegister: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
  },
  { ...softDeleteOptions, tableName: 'customers' },
);

export const CustomerIdentity = sequelize.define(
  'CustomerIdentity',
  {
    id: uuid(),
    customerId: customerId(),
    method: { type: DataTypes.STRING(5), allowNull: false },
    contact: { type: DataTypes.STRING(254), allowNull: false },
    verifiedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: 'customer_identities', underscored: true, timestamps: false },
);

export const CustomerOtpChallenge = sequelize.define(
  'CustomerOtpChallenge',
  {
    id: uuid(),
    method: { type: DataTypes.STRING(5), allowNull: false },
    contact: { type: DataTypes.STRING(254), allowNull: false },
    codeHash: { type: DataTypes.CHAR(64), allowNull: false },
    attempts: { type: DataTypes.INTEGER, defaultValue: 0, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: DataTypes.DATE,
  },
  {
    tableName: 'customer_otp_challenges',
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

export const CustomerLoginLog = sequelize.define(
  'CustomerLoginLog',
  {
    id: uuid(),
    customerId: customerId(),
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    deviceInfo: DataTypes.JSONB,
    userAgent: DataTypes.STRING(512),
    ipAddress: DataTypes.STRING(64),
  },
  {
    ...softDeleteOptions,
    tableName: 'customer_login_logs',
    createdAt: 'loginAt',
    updatedAt: false,
  },
);

export const CustomerAddress = sequelize.define(
  'CustomerAddress',
  {
    id: uuid(),
    customerId: customerId(),
    line1: { type: DataTypes.STRING(200), allowNull: false },
    line2: { type: DataTypes.STRING(200), defaultValue: '', allowNull: false },
    landmark: { type: DataTypes.STRING(200), defaultValue: '', allowNull: false },
    state: { type: DataTypes.STRING(100), allowNull: false },
    city: { type: DataTypes.STRING(100), allowNull: false },
    postalCode: { type: DataTypes.STRING(6), allowNull: false },
    houseNumber: { type: DataTypes.STRING(100), defaultValue: '', allowNull: false },
    buildingName: { type: DataTypes.STRING(200), defaultValue: '', allowNull: false },
    location: DataTypes.JSONB,
    latitude: DataTypes.DOUBLE,
    longitude: DataTypes.DOUBLE,
  },
  { ...softDeleteOptions, tableName: 'customer_addresses' },
);

export const CustomerFamilyMember = sequelize.define(
  'CustomerFamilyMember',
  {
    id: uuid(),
    customerId: customerId(),
    name: { type: DataTypes.STRING(200), allowNull: false },
    relationship: { type: DataTypes.STRING(30), allowNull: false },
    age: DataTypes.INTEGER,
    dateOfBirth: DataTypes.DATEONLY,
    gender: DataTypes.STRING(30),
    phone: DataTypes.STRING(10),
  },
  { ...softDeleteOptions, tableName: 'customer_family_members' },
);

CustomerLoginLog.belongsTo(Customer, { as: 'customer', foreignKey: 'customerId' });
