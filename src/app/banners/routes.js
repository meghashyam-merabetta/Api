import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';

export const bannerRoutes = [{
  method: 'get', path: '/banners', auth: false,
  handler: async (_req, res) => {
    const data = await sequelize.query('SELECT banner_key, page_name, banner_name, image_path, width_px, height_px, is_active FROM page_banners ORDER BY banner_key', { type: QueryTypes.SELECT });
    res.set('Cache-Control', 'no-store');
    res.json({ data });
  },
}];
