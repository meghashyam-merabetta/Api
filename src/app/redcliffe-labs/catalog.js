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
  const categories = [
    ...new Set(
      (Array.isArray(row.category_for_web) ? row.category_for_web : [])
        .map((category) =>
          typeof category?.name === 'string' ? category.name.trim() : '',
        )
        .filter(Boolean),
    ),
  ];
  if (!categories.length) categories.push(String(row.type || 'Lab test'));
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
    category: categories[0],
    categories,
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
    while (true) {
      const more = await sequelize.transaction(async (transaction) => {
        const options = { transaction, type: QueryTypes.SELECT };
        const [lock] = await sequelize.query(
          "SELECT pg_try_advisory_xact_lock(hashtext('redcliffe-catalog')) AS acquired",
          options,
        );
        if (!lock.acquired) return false;
        const [state] = await sequelize.query(
          "SELECT * FROM lab_catalog_sync WHERE lab_id='redcliffe' FOR UPDATE",
          options,
        );
        if (!state) return false;
        if (state.retry_at && new Date(state.retry_at).getTime() > Date.now())
          return false;
        if (
          state.status === 'complete' &&
          Date.now() - new Date(state.completed_at).getTime() < 7200000
        )
          return false;
        if (state.status === 'idle' || state.status === 'complete') {
          await sequelize.query(
            "UPDATE lab_catalog_sync SET status='syncing',next_page=1,pages_done=0,processed=0,total=0,started_at=now(),error=NULL,retry_at=NULL WHERE lab_id='redcliffe'",
            { transaction },
          );
          state.next_page = 1;
          state.processed = 0;
        }
        // The savepoint lets a failed page roll back without losing earlier pages or its checkpoint.
        try {
          return await sequelize.transaction({ transaction }, async (pageTransaction) => {
            const page = state.next_page;
            const body = await providerRequest(paths.packages, { page });
            const result = parseCatalogPage(body, page);
            const rows = result.rows;
            if (rows.length)
              await sequelize.query(
                "INSERT INTO lab_packages(id,lab_id,package_code,catalog_data,provider_data) SELECT r.id,'redcliffe',r.code,r.data,r.raw FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(id text,code text,data jsonb,raw jsonb) ON CONFLICT(id) DO UPDATE SET catalog_data=EXCLUDED.catalog_data,provider_data=EXCLUDED.provider_data,active=true,synced_at=now()",
                {
                  replacements: { rows: JSON.stringify(rows) },
                  transaction: pageTransaction,
                },
              );
            if (!result.next && !state.processed && !rows.length)
              throw new HttpError(502, 'Redcliffe has no bookable packages available.');
            if (!result.next)
              await sequelize.query(
                "UPDATE lab_packages SET active=false WHERE lab_id='redcliffe' AND synced_at < (SELECT started_at FROM lab_catalog_sync WHERE lab_id='redcliffe')",
                { transaction: pageTransaction },
              );
            await sequelize.query(
              "UPDATE lab_catalog_sync SET status=:status,next_page=:next,pages_done=pages_done+1,processed=processed+:count,total=:total,error=NULL,retry_at=NULL,completed_at=CASE WHEN :done THEN now() ELSE completed_at END WHERE lab_id='redcliffe'",
              {
                replacements: {
                  status: result.next ? 'syncing' : 'complete',
                  next: result.next || 1,
                  count: body.data.length,
                  total: Number(body.count) || 0,
                  done: !result.next,
                },
                transaction: pageTransaction,
              },
            );
            return Boolean(result.next);
          });
        } catch {
          await sequelize.query(
            "UPDATE lab_catalog_sync SET status='retrying',error='Catalogue update interrupted. Retrying automatically.',retry_at=now()+interval '30 seconds' WHERE lab_id='redcliffe'",
            { transaction },
          );
          logger.warn(
            { page: state.next_page },
            'Catalogue page failed; saved pages retained',
          );
          return false;
        }
      });
      if (!more) break;
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

export function parseCatalogPage(body, page) {
  if (!providerSucceeded(body) || !Array.isArray(body.data))
    throw new HttpError(502, 'Redcliffe package list is unavailable.');
  const rows = new Map();
  for (const raw of body.data) {
    if (!raw || !String(raw.code || '').trim()) continue;
    const data = normalizePackage(raw);
    rows.set(data.id, { id: data.id, code: data.packageCode, data, raw });
  }
  const next = body.links?.next
    ? Number(
        new URL(body.links.next, 'https://pagination.invalid').searchParams.get('page'),
      )
    : 0;
  if (body.links?.next && (!Number.isSafeInteger(next) || next <= page || next > 200))
    throw new HttpError(502, 'Redcliffe package pagination is invalid.');
  return { rows: [...rows.values()], next };
}

export function startCatalogSyncWorker() {
  const tick = () => {
    void syncPackages().catch(() =>
      logger.warn('Catalogue worker unavailable; will retry'),
    );
  };
  tick();
  const timer = setInterval(tick, 30000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function catalog(_req, res) {
  const lab = await models.lab.findOne({ where: { id: 'redcliffe', active: true } });
  if (!lab) throw new HttpError(503, 'Redcliffe Labs is currently unavailable.');
  void syncPackages().catch(() =>
    logger.warn('Catalogue update unavailable; serving saved tests'),
  );
  const [rows, states] = await Promise.all([
    sequelize.query(
      "SELECT catalog_data FROM lab_packages WHERE lab_id='redcliffe' AND active ORDER BY catalog_data->>'name'",
      { type: QueryTypes.SELECT },
    ),
    sequelize.query(
      "SELECT status,pages_done,total,processed,completed_at,error FROM lab_catalog_sync WHERE lab_id='redcliffe'",
      { type: QueryTypes.SELECT },
    ),
  ]);
  res.json({
    data: rows.map((row) => row.catalog_data),
    sync: states[0] || { status: 'idle' },
  });
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
