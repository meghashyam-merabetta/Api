import { models } from '../../models/index.js';
import { HttpError } from '../../shared/errors.js';

export function getPublic(_req, res) {
  res.json({ message: 'Public app endpoint' });
}

export async function listFaqs(_req, res) {
  const data = await models.faq.findAll({
    where: { active: true },
    attributes: ['id', 'question', 'answer'],
    order: [
      ['sortOrder', 'ASC'],
      ['question', 'ASC'],
    ],
  });
  res.json({ data });
}

export async function listStates(_req, res) {
  const data = await models.masterState.findAll({
    attributes: ['id', 'name'],
    order: [['name', 'ASC']],
  });
  res.json({ data });
}

export async function listCities(req, res) {
  const { stateId } = req.validatedParams;
  const state = await models.masterState.findByPk(stateId);
  if (!state) throw new HttpError(404, 'State not found');

  const data = await models.masterCity.findAll({
    where: { stateId },
    attributes: ['id', 'stateId', 'name'],
    order: [['name', 'ASC']],
  });
  res.json({ data });
}
