import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { requireGateway } from '../hdfc/client.js';
import { syncOrder } from './orders.controller.js';
import { logger } from '../../config/logger.js';

export function startPaymentReconciliation() {
  let running = false,
    stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    try {
      requireGateway();
    } catch {
      return;
    }
    running = true;
    try {
      // Claim a small batch so multiple API processes do not poll the same order.
      const rows = await sequelize.transaction(async (transaction) => {
        const claimed = await sequelize.query(
          "SELECT * FROM product_checkouts WHERE stock_state IN ('reserved','released') AND payment_status<>'CHARGED' AND created_at>now()-interval '7 days' AND (payment_checked_at IS NULL OR payment_checked_at<now()-interval '2 minutes') ORDER BY payment_checked_at NULLS FIRST,created_at LIMIT 5 FOR UPDATE SKIP LOCKED",
          { type: QueryTypes.SELECT, transaction },
        );
        for (const row of claimed)
          await sequelize.query(
            'UPDATE product_checkouts SET payment_checked_at=now() WHERE id=:id',
            { replacements: { id: row.id }, transaction },
          );
        return claimed;
      });
      for (const row of rows) {
        if (stopped) break;
        try {
          await syncOrder(row);
        } catch {
          logger.warn(
            { orderId: row.id },
            'Payment reconciliation deferred; stock unchanged',
          );
        }
      }
    } catch {
      logger.error('Payment reconciliation failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 30000).unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
