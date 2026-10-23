import nodemailer from 'nodemailer';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { smtpConfig } from '../email/client.js';
export async function deliverContactNotification(
  createTransport = nodemailer.createTransport,
  enquiryId = null,
) {
  await sequelize.transaction(async (transaction) => {
    const [row] = await sequelize.query(
      'SELECT * FROM contact_enquiries WHERE notification_sent_at IS NULL AND notification_retry_at<=now()' +
        (enquiryId ? ' AND id=:enquiryId' : '') +
        ' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1',
      { type: QueryTypes.SELECT, transaction, replacements: { enquiryId } },
    );
    if (!row) return;
    let transport;
    let sent = false;
    try {
      transport = createTransport(smtpConfig());
      const result = await transport.sendMail({
        from: { name: 'Merabetta', address: env.SMTP_FROM },
        to: 'support@merabetta.com',
        replyTo: row.email,
        subject: `Contact enquiry ${row.id}`,
        text: `Enquiry ID: ${row.id}\nName: ${row.name}\nEmail: ${row.email}\nPhone: ${row.phone}\n\n${row.message}`,
      });
      sent = !!result.accepted?.length && !result.rejected?.length;
    } catch {
      logger.warn({ enquiryId: row.id }, 'Contact notification failed; saved for manual retry');
    } finally {
      transport?.close();
    }
    await sequelize.query(
      "UPDATE contact_enquiries SET notification_attempts=notification_attempts+1,notification_sent_at=CASE WHEN :sent THEN now() ELSE NULL END,notification_retry_at=now()+interval '5 minutes' WHERE id=:id",
      { replacements: { id: row.id, sent }, transaction },
    );
  });
}
