import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { models } from '../../models/index.js';
import { logger } from '../../config/logger.js';
import { HttpError } from '../../shared/errors.js';
import { paths, providerRequest, providerSucceeded } from './client.js';

export function normalizePackage(row) {
  const code = String(row.code || '').trim();
  const price = Number(row.package_center_prices?.offer_price);
  const mrp = Number(row.package_center_prices?.package_price);
  if (
    !code ||
    code.length > 85 ||
    !row.name ||
    row.package_center_prices?.offer_price === null ||
    row.package_center_prices?.offer_price === undefined ||
    row.package_center_prices?.package_price === null ||
    row.package_center_prices?.package_price === undefined ||
    !Number.isFinite(price) ||
    !Number.isFinite(mrp) ||
    price < 0 ||
    mrp < price
  )
    throw new HttpError(502, 'Redcliffe returned invalid package data.');
  return {
    id: `redcliffe:${code}`,
    testId: `redcliffe:${code}`,
    packageCode: code,
    labId: 'redcliffe',
    labName: 'Redcliffe Labs',
    lab: true,
    name: String(row.name),
    subtitle: String(row.description || row.name),
    category: String(row.type || 'Lab test'),
    price,
    mrp,
    image: 'lab.png',
    rating: '',
    parameters: Math.max(1, Number(row.parameters || row.parameter) || 1),
    groups: [],
    reportHours: null,
    reportTime: String(row.tat_time || 'Confirm with the lab'),
    sampleType: 'Home sample collection',
    fasting: String(row.fasting_time || 'Confirm with the lab'),
    available: true,
  };
}

let syncing;
export async function syncPackages() {
  if (syncing) return syncing;
  syncing = (async () => {
    const rows = [];
    let page = 1;
    const seen = new Set();
    while (page) {
      if (seen.has(page) || seen.size >= 200)
        throw new HttpError(502, 'Redcliffe package pagination is invalid.');
      seen.add(page);
      const body = await providerRequest(paths.packages, {
        query: { page: String(page) },
      });
      if (!providerSucceeded(body) || !Array.isArray(body.data))
        throw new HttpError(502, 'Redcliffe package list is unavailable.');
      for (const raw of body.data) {
        // A package without a provider code cannot be booked. Do not let it
        // prevent customers from seeing the other, valid packages.
        if (!raw || !String(raw.code || '').trim()) {
          logger.warn({ page }, 'Skipping Redcliffe package without a booking code');
          continue;
        }
        rows.push({ raw, data: normalizePackage(raw) });
      }
      // Follow only the page number, never fetch an arbitrary provider-supplied URL with our key.
      page = body.links?.next
        ? Number(
            new URL(body.links.next, 'https://pagination.invalid').searchParams.get(
              'page',
            ),
          )
        : 0;
      if (body.links?.next && (!Number.isSafeInteger(page) || page < 1))
        throw new HttpError(502, 'Redcliffe package pagination is invalid.');
    }
    if (!rows.length)
      throw new HttpError(502, 'Redcliffe has no bookable packages available.');
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        "SELECT pg_advisory_xact_lock(hashtext('redcliffe-catalog'))",
        { transaction },
      );
      await sequelize.query(
        "UPDATE lab_packages SET active=false WHERE lab_id='redcliffe'",
        { transaction },
      );
      for (const { raw, data } of rows)
        await sequelize.query(
          `INSERT INTO lab_packages(id,lab_id,package_code,catalog_data,provider_data) VALUES(:id,'redcliffe',:code,CAST(:data AS jsonb),CAST(:raw AS jsonb)) ON CONFLICT(id) DO UPDATE SET catalog_data=EXCLUDED.catalog_data,provider_data=EXCLUDED.provider_data,active=true,synced_at=now()`,
          {
            replacements: {
              id: data.id,
              code: data.packageCode,
              data: JSON.stringify(data),
              raw: JSON.stringify(raw),
            },
            transaction,
          },
        );
    });
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

export async function catalog(_req, res) {
  const lab = await models.lab.findOne({ where: { id: 'redcliffe', active: true } });
  if (!lab) throw new HttpError(503, 'Redcliffe Labs is currently unavailable.');
  const recent = await sequelize.query(
    "SELECT 1 FROM lab_packages WHERE lab_id='redcliffe' AND active AND synced_at > now() - interval '1 hour' LIMIT 1",
    { type: QueryTypes.SELECT },
  );
  if (!recent.length) await syncPackages();
  const rows = await sequelize.query(
    "SELECT catalog_data FROM lab_packages WHERE lab_id='redcliffe' AND active ORDER BY catalog_data->>'name'",
    { type: QueryTypes.SELECT },
  );
  res.json({ data: rows.map((row) => row.catalog_data) });
}

export async function parameters(req, res) {
  const { code } = req.validatedParams;
  const rows = await sequelize.query(
    "SELECT parameter_data,parameters_synced_at FROM lab_packages WHERE lab_id='redcliffe' AND package_code=:code AND active",
    { replacements: { code }, type: QueryTypes.SELECT },
  );
  if (!rows.length) throw new HttpError(404, 'Package is not available.');
  let body = rows[0].parameter_data;
  if (
    !body ||
    !rows[0].parameters_synced_at ||
    Date.now() - new Date(rows[0].parameters_synced_at).getTime() > 86400000
  ) {
    body = await providerRequest(paths.parameters, { query: { code } });
    if (!providerSucceeded(body) || !Array.isArray(body.data))
      throw new HttpError(502, 'Test parameters could not be loaded.');
    await sequelize.query(
      "UPDATE lab_packages SET parameter_data=CAST(:body AS jsonb),parameters_synced_at=now() WHERE lab_id='redcliffe' AND package_code=:code",
      { replacements: { code, body: JSON.stringify(body) } },
    );
  }
  res.json({
    data: body.data.map((group) => ({
      name: String(group.name || ''),
      parameters: (group.package_detail || []).map((item) => String(item.name || '')),
    })),
  });
}
