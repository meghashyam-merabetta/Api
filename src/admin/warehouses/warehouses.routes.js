import {
  listWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
} from './warehouses.controller.js';
import {
  createWarehouseSchema,
  updateWarehouseSchema,
  warehouseParams,
  warehouseQuery,
} from './warehouses.schema.js';

export const warehousesRoutes = [
  { method: 'get', path: '/', query: warehouseQuery, handler: listWarehouses },
  { method: 'post', path: '/', schema: createWarehouseSchema, handler: createWarehouse },
  {
    method: 'get',
    path: '/:warehouseId',
    params: warehouseParams,
    handler: getWarehouse,
  },
  ...['put', 'patch'].map((method) => ({
    method,
    path: '/:warehouseId',
    params: warehouseParams,
    schema: updateWarehouseSchema,
    handler: updateWarehouse,
  })),
  {
    method: 'delete',
    path: '/:warehouseId',
    params: warehouseParams,
    handler: deleteWarehouse,
  },
];
