import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const Category = sequelize.define(
  'Category',
  {
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
    category_id: {
      type: DataTypes.BIGINT,
      field: 'id',
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    category_name: {
      type: DataTypes.STRING(150),
      field: 'name',
      allowNull: false,
      validate: { notEmpty: true },
    },
    slug: {
      type: DataTypes.STRING(180),
      allowNull: false,
    },
    parent_category_id: {
      type: DataTypes.BIGINT,
      field: 'parent_id',
      allowNull: true,
    },
    category_image: {
      type: DataTypes.TEXT,
      field: 'image_url',
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    sort_order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: 'categories',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

// Keep the API alias out of Sequelize's attribute map: a VIRTUAL image_url
// collides with category_image's physical column and can drop bulk-insert images.
Category.prototype.toJSON = function () {
  const values = this.get({ plain: true });
  return { ...values, image_url: values.category_image ?? null };
};
