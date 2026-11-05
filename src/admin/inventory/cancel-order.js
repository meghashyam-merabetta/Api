import { returnTeamStock } from '../../catalog/inventory.js';
import { z } from 'zod';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';
import { catalogTransaction, auditContext } from '../../shared/catalog-audit.js';
import { settleStock } from '../../app/orders/inventory.js';

export const cancelOrderRoute = {
  method: 'post',
  path: '/products/:id/cancel',
  params: z.object({ id: z.string().regex(/^MB(?:[0-9]{11}|[a-f0-9]{18})$/) }).strict(),
  schema: z.object({ reason: z.string().trim().min(1).max(1000) }).strict(),
  handler: async (req, res) => {
    const profile = await models.adminProfile.findOne({
      where: { userId: req.auth.userId },
    });
    if (
      !profile?.permissions?.some((value) =>
        ['*', 'admin.manage', 'inventory.adjust'].includes(value),
      )
    )
      throw new HttpError(403, 'Inventory adjustment permission required');
    const result = await catalogTransaction(req, async (transaction) => {
      const id = req.validatedParams.id;
      const [row] = await sequelize.query(
        'SELECT * FROM product_checkouts WHERE id=:id FOR UPDATE',
        { replacements: { id }, type: QueryTypes.SELECT, transaction },
      );
      if (!row) throw new HttpError(404, 'Order not found');
      if (row.payload.cancelled) return row.payload;
      if (row.payment_status === 'CHARGED')
        throw new HttpError(
          409,
          'Paid cancellations require an approved refund/return workflow',
        );
      if (row.payment_status === 'COD' && row.payload.status !== 'Confirmed')
        throw new HttpError(409, 'Order fulfilment must be reviewed before cancellation');
      await auditContext(req, transaction, {
        movement: 'cancellation',
        order: id,
        reason: req.validated.reason,
      });
      if (row.stock_state === 'reserved')
        await settleStock(id, false, transaction, req, 'cancellation');
      else if (row.stock_state === 'deducted' && row.payment_status === 'COD') {
        await returnTeamStock(id, transaction, req);
      }
      const payload = {
        ...row.payload,
        cancelled: true,
        fulfillmentBlocked: true,
        status: 'Cancelled',
        cancellationReason: req.validated.reason,
      };
      await sequelize.query(
        "UPDATE product_checkouts SET stock_state='cancelled',payment_status=CASE WHEN payment_status='COD' THEN payment_status ELSE 'FAILED' END,payment_url=NULL,payload=CAST(:payload AS jsonb),updated_at=now() WHERE id=:id",
        { replacements: { id, payload: JSON.stringify(payload) }, transaction },
      );
      await sequelize.query(
        "UPDATE orders SET stock_state='cancelled',payload=CAST(:payload AS jsonb),updated_at=now() WHERE id=:id",
        { replacements: { id, payload: JSON.stringify(payload) }, transaction },
      );
      return payload;
    });
    res.json({ data: result });
  },
};
