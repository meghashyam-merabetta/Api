import {DataTypes} from 'sequelize'
import {sequelize} from '../config/database.js'
export const Product_management = sequelize.define(

    'Product_management',
  {
    product_id:{
        type: DataTypes.INTEGER ,
        primarykey: true,
        allowNull:  false,
        autoIncrement: true,
        
    },
    product_name:{
        type: DataTypes.STRING,},
    prescription_required:{
        equired:true

    },
    age_group:{
        type: DataTypes.STRING,
    },
  },

);

export const Warehouse_management = sequelize.define(

    'warehouse_management',{
    warehouse_id:{
        type: DataTypes.INTEGER,
        primerykey:true,
        allowNull:false,
        autoIncrement: true,

    },
}

);