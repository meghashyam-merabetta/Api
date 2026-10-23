import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { sequelize } from '../../config/database.js';
import { deliverContactNotification } from './notifications.js';
import { logger } from '../../config/logger.js';
export const contactSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    phone: z
      .string()
      .trim()
      .regex(/^(?:\+91[ -]?)?[6-9]\d{9}$/),
    message: z.string().trim().min(1).max(5000),
  })
  .strict();
export const contactRoutes = [
  {
    method: 'post',
    path: '/contact-enquiries',
    auth: false,
    middleware: [
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 5,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
      }),
    ],
    schema: contactSchema,
    handler: async (req, res) => {
      const id = randomUUID();
      await sequelize.query(
        'INSERT INTO contact_enquiries(id,name,email,phone,message) VALUES(:id,:name,:email,:phone,:message)',
        { replacements: { id, ...req.validated } },
      );
      res
        .status(201)
        .json({
          enquiryId: id,
          confirmation:
            'Your enquiry has been received. Our support team will contact you.',
        });
      void deliverContactNotification(undefined, id).catch(() => {
        logger.warn({ enquiryId: id }, 'Contact notification failed; enquiry remains saved');
      });
    },
  },
];
