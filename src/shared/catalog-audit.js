import { sequelize } from '../config/database.js';

// Transaction-local settings cannot leak an actor into another pooled request.
export async function auditContext(req, transaction, details = {}) {
  const actor = req?.auth?.realm === 'admin' ? req.auth.userId : null;
  await sequelize.query(
    `SELECT set_config('catalog.actor',:actor,true),set_config('catalog.actor_type',:type,true),
    set_config('catalog.request_id',:request,true),set_config('catalog.reason',:reason,true),
    set_config('catalog.movement_type',:movement,true),set_config('catalog.order_id',:order,true)`,
    {
      replacements: {
        actor: actor ?? '',
        type: actor ? 'admin' : 'system',
        request: String(req?.id ?? ''),
        reason: details.reason ?? '',
        movement: details.movement ?? '',
        order: details.order ?? '',
      },
      transaction,
    },
  );
}
export const catalogTransaction = (req, execute) =>
  sequelize.transaction(async (transaction) => {
    await auditContext(req, transaction);
    return execute(transaction);
  });
export async function mappingEvent(productId, action, oldValues, newValues, transaction) {
  await sequelize.query(
    `INSERT INTO audit_logs(entity_type,entity_id,action,old_values,new_values,changed_fields,changed_by,actor_type,request_id)
    VALUES('product_category',:id,:action,CAST(:old AS jsonb),CAST(:new AS jsonb),ARRAY[:fields],
      NULLIF(current_setting('catalog.actor',true),'')::uuid,COALESCE(NULLIF(current_setting('catalog.actor_type',true),''),'system'),NULLIF(current_setting('catalog.request_id',true),''))`,
    {
      replacements: {
        id: String(productId),
        action,
        old: JSON.stringify(oldValues),
        new: JSON.stringify(newValues),
        fields:
          action === 'primary_category_changed'
            ? ['primary_category_id']
            : ['category_id'],
      },
      transaction,
    },
  );
}
