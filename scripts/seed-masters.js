import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sequelize } from '../src/config/database.js';
import { Faq, MasterState, MasterCity } from '../src/models/master.model.js';

export async function seedMasters(transaction) {
  const locations = JSON.parse(readFileSync(new URL('../seed/india-locations.json', import.meta.url), 'utf8'));
  const faqs = JSON.parse(readFileSync(new URL('../seed/faqs.json', import.meta.url), 'utf8'));

  // Insert missing records only: reruns preserve IDs and administrator edits.
  await MasterState.bulkCreate(locations.map(({ name }) => ({ name })), {
    ignoreDuplicates: true,
    transaction,
  });
  const states = await MasterState.findAll({ transaction });
  const stateIds = new Map(states.map(state => [state.name, state.id]));
  const cities = locations.flatMap(state =>
    state.cities.map(name => ({ name, stateId: stateIds.get(state.name) })),
  );
  for (let offset = 0; offset < cities.length; offset += 500) {
    await MasterCity.bulkCreate(cities.slice(offset, offset + 500), {
      ignoreDuplicates: true,
      transaction,
    });
  }
  await Faq.bulkCreate(faqs.map(([question, answer], sortOrder) => ({
    question, answer, sortOrder,
  })), { ignoreDuplicates: true, transaction });
  console.log(`Master seed ready: ${locations.length} states, ${cities.length} cities, ${faqs.length} FAQs.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await sequelize.transaction(seedMasters);
  } finally {
    await sequelize.close();
  }
}
