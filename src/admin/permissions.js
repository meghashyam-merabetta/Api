export const ADMIN_PERMISSIONS = Object.freeze({
  manage: 'admin.manage',
  inventoryAdjust: 'inventory.adjust',
});

// Permissions granted when a normal CMS administrator is created without an
// explicitly restricted permission set.
export const DEFAULT_CMS_ADMIN_PERMISSIONS = Object.freeze([
  ADMIN_PERMISSIONS.inventoryAdjust,
]);
