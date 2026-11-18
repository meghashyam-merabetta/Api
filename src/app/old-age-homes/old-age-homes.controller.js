import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';

const objectOrEmpty = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const arrayOrEmpty = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

export function serializePublicOldAgeHome(row) {
  const images = [...new Set(arrayOrEmpty(row.facility_photographs))].slice(0, 10);
  const totalCapacity = Number(row.total_capacity) || 0;
  const currentResidents = Number(row.current_residents) || 0;
  return {
    id: row.id,
    name: row.home_name,
    subtitle: [row.city, row.state].filter(Boolean).join(', '),
    homeName: row.home_name,
    yearEstablished: row.year_established,
    organizationType: row.organization_type,
    address: row.address,
    city: row.city,
    state: row.state,
    pinCode: row.pin_code,
    website: row.website,
    totalCapacity,
    currentResidents,
    availableCapacity: Math.max(0, totalCapacity - currentResidents),
    medicalFacilities: objectOrEmpty(row.medical_facilities),
    servicesOffered: objectOrEmpty(row.services_offered),
    facilityPricing: objectOrEmpty(row.facility_pricing),
    image: images[0] ?? null,
    images,
    video: row.facility_video ?? null,
  };
}

const publicColumns = `
  c.id::text AS id, c.home_name, c.year_established, c.organization_type,
  c.address, c.city, c.state, c.pin_code, c.website,
  c.total_capacity, c.current_residents, c.medical_facilities,
  c.services_offered, c.facility_pricing,
  COALESCE(c.facility_photographs, ARRAY[]::text[]) AS facility_photographs,
  c.facility_video`;

function publicConditions({ city, state, service, q } = {}, replacements = {}) {
  const conditions = [
    `c.status = 'ACTIVE'`,
    `a.status = 'ACTIVE'`,
    'a.deleted_at IS NULL',
  ];
  if (city) {
    conditions.push('c.city ILIKE :city');
    replacements.city = city;
  }
  if (state) {
    conditions.push('c.state ILIKE :state');
    replacements.state = state;
  }
  if (service) {
    conditions.push(`COALESCE(c.services_offered ->> :service, 'false') = 'true'`);
    replacements.service = service;
  }
  if (q) {
    conditions.push(
      `(c.home_name ILIKE :q OR c.address ILIKE :q OR c.city ILIKE :q OR c.state ILIKE :q)`,
    );
    replacements.q = `%${q}%`;
  }
  return conditions;
}

export async function listOldAgeHomes(req, res) {
  const { limit, offset, city, state, service, q } = req.validatedQuery;
  const replacements = { limit, offset };
  const conditions = publicConditions({ city, state, service, q }, replacements);
  const rows = await sequelize.query(
    `SELECT ${publicColumns}, count(*) OVER()::int AS total
     FROM oldagehome.poc_client c
     JOIN oldagehome.poc_admin a ON a.id = c.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.home_name, c.id
     LIMIT :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT },
  );
  res.json({
    data: rows.map(serializePublicOldAgeHome),
    total: rows[0]?.total ?? 0,
  });
}

export async function getOldAgeHome(req, res) {
  const rows = await sequelize.query(
    `SELECT ${publicColumns}
     FROM oldagehome.poc_client c
     JOIN oldagehome.poc_admin a ON a.id = c.id
     WHERE c.id = :id
       AND c.status = 'ACTIVE'
       AND a.status = 'ACTIVE'
       AND a.deleted_at IS NULL`,
    { replacements: { id: req.validatedParams.id }, type: QueryTypes.SELECT },
  );
  if (!rows[0]) throw new HttpError(404, 'Old age home not found');
  res.json({ data: serializePublicOldAgeHome(rows[0]) });
}

export async function getOldAgeHomeCatalog(req, res) {
  const rows = await sequelize.query(
    `SELECT ${publicColumns}
     FROM oldagehome.poc_client c
     JOIN oldagehome.poc_admin a ON a.id = c.id
     WHERE c.status = 'ACTIVE'
       AND a.status = 'ACTIVE'
       AND a.deleted_at IS NULL
     ORDER BY c.home_name, c.id`,
    { type: QueryTypes.SELECT },
  );
  res.json({ data: { oldAgeHomes: rows.map(serializePublicOldAgeHome) } });
}
