import { DataTypes } from 'sequelize';

// Kept separate from connection configuration so the mapping can be tested offline.
export function defineProductVariant(sequelize) {
  return sequelize.define(
    'ProductVariant',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      product_id: { type: DataTypes.BIGINT, allowNull: false },
      sku: { type: DataTypes.STRING(100), allowNull: false },
      use_product_images: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      variant_name: DataTypes.STRING(200),
      barcode: DataTypes.STRING(100),
      weight_grams: DataTypes.INTEGER,
      attributes: { type: DataTypes.JSONB, allowNull: false },
      regular_price: DataTypes.DECIMAL(12, 2),
      sale_price: DataTypes.DECIMAL(12, 2),
      stock_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      display_name: {
        type: DataTypes.VIRTUAL,
        get() {
          return (
            this.getDataValue('variant_name') ||
            Object.values(this.getDataValue('attributes') ?? {}).join(' / ')
          );
        },
      },
    },
    {
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: true,
      deletedAt: 'deleted_at',
      tableName: 'product_variants',
    },
  );
}
