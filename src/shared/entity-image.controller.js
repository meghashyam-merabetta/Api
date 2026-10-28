import { sequelize } from '../config/database.js';
import { HttpError } from './errors.js';
import { createImageUpload } from './image_upload.js';
import {
  imageUrl,
  queueImageUrlCleanup,
  reserveImage,
  stageImage,
} from './image-storage.js';

// Attach one managed image to a model's existing nullable URL column.
// No generic resource name or storage key is accepted from the client.
export function createEntityImageControllers({
  model,
  resource,
  idParam,
  idField,
  imageField,
  label,
}) {
  const multipart = createImageUpload();
  const parse = (req, res) =>
    new Promise((resolve, reject) => {
      multipart(req, res, (error) => (error ? reject(error) : resolve()));
    });
  async function find(id, transaction) {
    const row = await model.findByPk(id, {
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!row) throw new HttpError(404, `${label} not found`);
    return row;
  }
  const view = (row) => ({ [idField]: row[idField], image_url: row[imageField] ?? null });
  const upload = async (req, res) => {
    await parse(req, res);
    const id = req.validatedParams[idParam];
    await find(id);
    const file = req.files[0];
    // Commit the recovery journal before acquiring the parent-row transaction.
    const reserved = await reserveImage(resource, id, file);
    const row = await sequelize.transaction(async (transaction) => {
      const current = await find(id, transaction);
      const { key, journal } = await stageImage(reserved, file, transaction);
      await queueImageUrlCleanup(current[imageField], transaction);
      await current.update({ [imageField]: imageUrl(key) }, { transaction });
      await journal.destroy({ transaction });
      return current;
    });
    res.status(req.method === 'POST' ? 201 : 200).json({ data: view(row) });
  };
  return {
    getImage: async (req, res) => {
      res.json({ data: view(await find(req.validatedParams[idParam])) });
    },
    uploadImage: upload,
    deleteImage: async (req, res) => {
      await sequelize.transaction(async (transaction) => {
        const row = await find(req.validatedParams[idParam], transaction);
        await queueImageUrlCleanup(row[imageField], transaction);
        await row.update({ [imageField]: null }, { transaction });
      });
      res.status(204).end();
    },
  };
}
