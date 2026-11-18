import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
import { ProductImageCleanup } from '../../models/catalog-reliability.model.js';
import { verifyEnrollmentReceipts } from '../../app/enrollments/enrollment-chunks.js';
import {
  finishImageCleanup,
  imageStorageScope,
  imageUrl,
  managedImageKeyFromUrl,
  queueImageUrlCleanup,
} from '../../shared/image-storage.js';

function serializeEnrollmentSummary(row) {
  return {
    id: row.id,
    homeName: row.home_name,
    city: row.city,
    contactPersonName: row.contact_person_name,
    mobileNumber: row.mobile_number,
    status: row.status,
    submissionDate: row.submission_date,
    approvedAt: row.approved_at,
  };
}

function serializeEnrollmentDetail(row) {
  return {
    id: row.id,
    status: row.status,
    poc_client: {
      homeName: row.home_name,
      yearEstablished: row.year_established,
      organizationType: row.organization_type,
      address: row.address,
      city: row.city,
      state: row.state,
      pinCode: row.pin_code,
      website: row.website,
      totalCapacity: row.total_capacity,
      currentResidents: row.current_residents,
      medicalFacilities: row.medical_facilities,
      servicesOffered: row.services_offered,
      facilityPricing: row.facility_pricing,
      facilityPhotographs: row.facility_photographs,
      facilityVideo: row.facility_video,
    },
    poc_admin: {
      registrationNumber: row.registration_number,
      contactPersonName: row.contact_person_name,
      designation: row.designation,
      mobileNumber: row.mobile_number,
      emailAddress: row.email_address,
      // S3 presigned GET URLs for these 7 documents can be plugged in here later.
      registrationCertificate: row.registration_certificate,
      panCard: row.pan_card,
      gstCertificate: row.gst_certificate,
      addressProof: row.address_proof,
      representativeIdProof: row.representative_id_proof,
      bankAccountDetails: row.bank_account_details,
      licensesCertificates: row.licenses_certificates,
      commercialAgreed: row.commercial_agreed,
      declarationAgreed: row.declaration_agreed,
      submissionDate: row.submission_date,
      ownerName: row.owner_name,
      ownerPhone: row.owner_phone,
      ownerEmail: row.owner_email,
      digitalSignature: row.digital_signature,
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
    },
  };
}

function encodeCursor(row) {
  return Buffer.from(
    JSON.stringify({ submissionDate: row.submission_date, id: row.id }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed?.submissionDate || !parsed?.id) {
      throw new Error('Missing cursor fields');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid cursor');
  }
}

// 1. GET /api/admin/enrollments
export async function listEnrollments(req, res) {
  const { status, deleted, q, limit, cursor } = req.validatedQuery;

  const conditions = [
    deleted === 'true' ? 'a.deleted_at IS NOT NULL' : 'a.deleted_at IS NULL',
  ];
  const replacements = { limit: limit + 1 };

  if (status) {
    conditions.push('a.status = :status');
    replacements.status = status;
  }

  if (q) {
    conditions.push(
      '(c.home_name ILIKE :q OR c.city ILIKE :q OR a.contact_person_name ILIKE :q)',
    );
    replacements.q = `%${q}%`;
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    conditions.push(
      '(a.submission_date, a.id) < (CAST(:cursorDate AS date), CAST(:cursorId AS uuid))',
    );
    replacements.cursorDate = decoded.submissionDate;
    replacements.cursorId = decoded.id;
  }

  const rows = await sequelize.query(
    `SELECT a.id, c.home_name, c.city, a.contact_person_name, a.mobile_number,
            a.status, a.submission_date, a.approved_at
     FROM oldagehome.poc_admin a
     JOIN oldagehome.poc_client c ON c.id = a.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.submission_date DESC, a.id DESC
     LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT },
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;

  res.json({ data: items.map(serializeEnrollmentSummary), nextCursor });
}

// 2. GET /api/admin/enrollments/:id
export async function getEnrollment(req, res) {
  const { id } = req.validatedParams;
  const rows = await sequelize.query(
    `SELECT a.id, a.status,
            a.registration_number, a.contact_person_name, a.designation,
            a.mobile_number, a.email_address,
            a.registration_certificate, a.pan_card, a.gst_certificate,
            a.address_proof, a.representative_id_proof, a.bank_account_details,
            a.licenses_certificates, a.commercial_agreed, a.declaration_agreed,
            a.submission_date, a.owner_name, a.owner_phone, a.owner_email,
            a.digital_signature, a.approved_at, a.approved_by,
            a.updated_at, a.updated_by, a.deleted_at, a.deleted_by,
            c.home_name, c.year_established, c.organization_type,
            c.address, c.city, c.state, c.pin_code, c.website,
            c.total_capacity, c.current_residents,
            c.medical_facilities, c.services_offered, c.facility_pricing,
            c.facility_photographs, c.facility_video
     FROM oldagehome.poc_admin a
     JOIN oldagehome.poc_client c ON c.id = a.id
     WHERE a.id = :id`,
    { replacements: { id }, type: QueryTypes.SELECT },
  );

  if (!rows[0]) throw new HttpError(404, 'Enrollment not found');
  res.json({ data: serializeEnrollmentDetail(rows[0]) });
}

// 3. PATCH /api/admin/enrollments/:id/status
export async function updateEnrollmentStatus(req, res) {
  const { id } = req.validatedParams;
  const { status } = req.validated;
  const admin = req.user.email;

  await sequelize.transaction(async (transaction) => {
    const updatedAdmin = await sequelize.query(
      `UPDATE oldagehome.poc_admin
       SET status = :status,
           approved_at = CASE WHEN :status = 'ACTIVE' THEN now() ELSE approved_at END,
           approved_by = CASE WHEN :status = 'ACTIVE' THEN :admin ELSE approved_by END,
           updated_at = now(),
           updated_by = :admin
       WHERE id = :id AND deleted_at IS NULL
       RETURNING id`,
      { replacements: { id, status, admin }, type: QueryTypes.SELECT, transaction },
    );

    if (!updatedAdmin[0]) throw new HttpError(404, 'Enrollment not found');

    await sequelize.query(
      `UPDATE oldagehome.poc_client
       SET status = :status
       WHERE id = :id`,
      { replacements: { id, status }, transaction },
    );
  });

  res.json({ id, status });
}

// 4. PUT /api/admin/enrollments/:id
export async function updateEnrollment(req, res) {
  const { id } = req.validatedParams;
  const { poc_client: c, poc_admin: a } = req.validated;
  const admin = req.user.email;

  await sequelize.transaction(async (transaction) => {
    const updatedAdmin = await sequelize.query(
      `UPDATE oldagehome.poc_admin
       SET registration_number = :registrationNumber,
           contact_person_name = :contactPersonName,
           designation = :designation,
           mobile_number = :mobileNumber,
           email_address = :emailAddress,
           registration_certificate = :registrationCertificate,
           pan_card = :panCard,
           gst_certificate = :gstCertificate,
           address_proof = :addressProof,
           representative_id_proof = :representativeIdProof,
           bank_account_details = :bankAccountDetails,
           licenses_certificates = CASE
             WHEN CAST(:licensesCertificates AS jsonb) IS NULL THEN NULL
             ELSE ARRAY(SELECT jsonb_array_elements_text(CAST(:licensesCertificates AS jsonb)))
           END,
           commercial_agreed = :commercialAgreed,
           declaration_agreed = :declarationAgreed,
           owner_name = :ownerName,
           owner_phone = :ownerPhone,
           owner_email = :ownerEmail,
           digital_signature = :digitalSignature,
           updated_at = now(),
           updated_by = :admin
       WHERE id = :id AND deleted_at IS NULL
       RETURNING id`,
      {
        replacements: {
          id,
          registrationNumber: a.registrationNumber,
          contactPersonName: a.contactPersonName,
          designation: a.designation,
          mobileNumber: a.mobileNumber,
          emailAddress: a.emailAddress,
          registrationCertificate: a.registrationCertificate,
          panCard: a.panCard,
          gstCertificate: a.gstCertificate ?? null,
          addressProof: a.addressProof,
          representativeIdProof: a.representativeIdProof,
          bankAccountDetails: a.bankAccountDetails,
          licensesCertificates:
            a.licensesCertificates === undefined
              ? null
              : JSON.stringify(a.licensesCertificates),
          commercialAgreed: a.commercialAgreed,
          declarationAgreed: a.declarationAgreed,
          ownerName: a.ownerName,
          ownerPhone: a.ownerPhone,
          ownerEmail: a.ownerEmail,
          digitalSignature: a.digitalSignature,
          admin,
        },
        type: QueryTypes.SELECT,
        transaction,
      },
    );

    if (!updatedAdmin[0]) throw new HttpError(404, 'Enrollment not found');

    await sequelize.query(
      `UPDATE oldagehome.poc_client
       SET home_name = :homeName,
           year_established = :yearEstablished,
           organization_type = :organizationType,
           address = :address,
           city = :city,
           state = :state,
           pin_code = :pinCode,
           website = :website,
           total_capacity = :totalCapacity,
           current_residents = :currentResidents,
           medical_facilities = CAST(:medicalFacilities AS jsonb),
           services_offered = CAST(:servicesOffered AS jsonb),
           facility_pricing = CAST(:facilityPricing AS jsonb),
           facility_photographs = ARRAY(SELECT jsonb_array_elements_text(CAST(:facilityPhotographs AS jsonb))),
           facility_video = :facilityVideo
       WHERE id = :id`,
      {
        replacements: {
          id,
          homeName: c.homeName,
          yearEstablished: c.yearEstablished,
          organizationType: c.organizationType,
          address: c.address,
          city: c.city,
          state: c.state,
          pinCode: c.pinCode,
          website: c.website || null,
          totalCapacity: c.totalCapacity,
          currentResidents: c.currentResidents,
          medicalFacilities: JSON.stringify(c.medicalFacilities),
          servicesOffered: JSON.stringify(c.servicesOffered),
          facilityPricing: JSON.stringify(c.facilityPricing),
          facilityPhotographs: JSON.stringify(c.facilityPhotographs),
          facilityVideo: c.facilityVideo ?? null,
        },
        transaction,
      },
    );
  });

  res.json({ id, updated: true });
}

// 5. DELETE /api/admin/enrollments/:id (soft delete only)
export async function deleteEnrollment(req, res) {
  const { id } = req.validatedParams;
  const admin = req.user.email;

  await sequelize.transaction(async (transaction) => {
    const deletedAdmin = await sequelize.query(
      `UPDATE oldagehome.poc_admin
       SET status = 'INACTIVE',
           deleted_at = now(),
           deleted_by = :admin,
           updated_at = now(),
           updated_by = :admin
       WHERE id = :id AND deleted_at IS NULL
       RETURNING id`,
      { replacements: { id, admin }, type: QueryTypes.SELECT, transaction },
    );

    if (!deletedAdmin[0]) throw new HttpError(404, 'Enrollment not found');

    await sequelize.query(
      `UPDATE oldagehome.poc_client
       SET status = 'INACTIVE'
       WHERE id = :id`,
      { replacements: { id }, transaction },
    );
  });

  res.json({ id, deleted: true });
}

// 6. POST /api/admin/enrollments/:id/restore
export async function restoreEnrollment(req, res) {
  const { id } = req.validatedParams;
  const admin = req.user.email;

  await sequelize.transaction(async (transaction) => {
    const restoredAdmin = await sequelize.query(
      `UPDATE oldagehome.poc_admin
       SET deleted_at = NULL,
           deleted_by = NULL,
           status = 'INACTIVE',
           updated_at = now(),
           updated_by = :admin
       WHERE id = :id AND deleted_at IS NOT NULL
       RETURNING id`,
      { replacements: { id, admin }, type: QueryTypes.SELECT, transaction },
    );

    if (!restoredAdmin[0]) throw new HttpError(404, 'Deleted enrollment not found');
  });

  res.json({ id, status: 'INACTIVE', restored: true });
}

const mediaFields = {
  facilityPhotographs: {
    table: 'oldagehome.poc_client',
    column: 'facility_photographs',
    row: 'facility_photographs',
    array: true,
    max: 10,
  },
  facilityVideo: {
    table: 'oldagehome.poc_client',
    column: 'facility_video',
    row: 'facility_video',
  },
  registrationCertificate: {
    table: 'oldagehome.poc_admin',
    column: 'registration_certificate',
    row: 'registration_certificate',
  },
  panCard: { table: 'oldagehome.poc_admin', column: 'pan_card', row: 'pan_card' },
  gstCertificate: {
    table: 'oldagehome.poc_admin',
    column: 'gst_certificate',
    row: 'gst_certificate',
  },
  addressProof: {
    table: 'oldagehome.poc_admin',
    column: 'address_proof',
    row: 'address_proof',
  },
  representativeIdProof: {
    table: 'oldagehome.poc_admin',
    column: 'representative_id_proof',
    row: 'representative_id_proof',
  },
  bankAccountDetails: {
    table: 'oldagehome.poc_admin',
    column: 'bank_account_details',
    row: 'bank_account_details',
  },
  licensesCertificates: {
    table: 'oldagehome.poc_admin',
    column: 'licenses_certificates',
    row: 'licenses_certificates',
    array: true,
    max: 10,
  },
  digitalSignature: {
    table: 'oldagehome.poc_admin',
    column: 'digital_signature',
    row: 'digital_signature',
  },
};

// PUT /api/admin/enrollments/:id/media
export async function updateEnrollmentMedia(req, res) {
  const { id } = req.validatedParams;
  const { receipts, retain, clearFields } = req.validated;
  const { grouped } = receipts.length
    ? await verifyEnrollmentReceipts(receipts, { requireCompleteEnrollment: false })
    : { grouped: {} };
  const changedFields = new Set([
    ...Object.keys(grouped),
    ...Object.keys(retain),
    ...clearFields,
  ]);
  const cleanupKeys = [];
  const result = await sequelize.transaction(async (transaction) => {
    const [current] = await sequelize.query(
      `SELECT c.facility_photographs, c.facility_video,
              a.registration_certificate, a.pan_card, a.gst_certificate,
              a.address_proof, a.representative_id_proof,
              a.bank_account_details, a.licenses_certificates,
              a.digital_signature
       FROM oldagehome.poc_admin a
       JOIN oldagehome.poc_client c ON c.id = a.id
       WHERE a.id = :id AND a.deleted_at IS NULL
       FOR UPDATE OF a, c`,
      { replacements: { id }, type: QueryTypes.SELECT, transaction },
    );
    if (!current) throw new HttpError(404, 'Enrollment not found');

    for (const files of Object.values(grouped)) {
      for (const { key } of files) {
        const journal = await ProductImageCleanup.findByPk(key, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!journal || journal.storage_scope !== imageStorageScope)
          throw new HttpError(409, 'An uploaded file expired; upload it again');
        await journal.destroy({ transaction });
      }
    }

    const response = {};
    for (const field of changedFields) {
      const definition = mediaFields[field];
      const oldValues = definition.array
        ? (current[definition.row] ?? [])
        : current[definition.row]
          ? [current[definition.row]]
          : [];
      const newUrls = (grouped[field] ?? []).map(({ key }) => imageUrl(key));
      let next;
      if (definition.array) {
        let kept = clearFields.includes(field) ? [] : oldValues;
        if (Object.hasOwn(retain, field)) {
          if (retain[field].some((url) => !oldValues.includes(url)))
            throw new HttpError(400, `${field} retain contains an unknown URL`);
          kept = retain[field];
        }
        next = [...new Set([...kept, ...newUrls])];
        if (next.length > definition.max)
          throw new HttpError(
            400,
            `${field} can contain at most ${definition.max} files`,
          );
        await sequelize.query(
          `UPDATE ${definition.table}
           SET ${definition.column} = ARRAY(
             SELECT jsonb_array_elements_text(CAST(:value AS jsonb))
           )${definition.table.endsWith('poc_admin') ? ', updated_at = now(), updated_by = :admin' : ''}
           WHERE id = :id`,
          {
            replacements: {
              id,
              value: JSON.stringify(next),
              admin: req.user.email,
            },
            transaction,
          },
        );
        response[field] = next;
      } else {
        if (newUrls.length > 1)
          throw new HttpError(400, `${field} accepts only one file`);
        next = newUrls[0] ?? (clearFields.includes(field) ? null : oldValues[0]);
        await sequelize.query(
          `UPDATE ${definition.table}
           SET ${definition.column} = :value${definition.table.endsWith('poc_admin') ? ', updated_at = now(), updated_by = :admin' : ''}
           WHERE id = :id`,
          {
            replacements: { id, value: next ?? null, admin: req.user.email },
            transaction,
          },
        );
        response[field] = next ?? null;
      }
      const retained = definition.array ? next : next ? [next] : [];
      for (const oldUrl of oldValues.filter((url) => !retained.includes(url))) {
        const key = managedImageKeyFromUrl(oldUrl);
        if (key) cleanupKeys.push(key);
        await queueImageUrlCleanup(oldUrl, transaction);
      }
    }
    return response;
  });
  await finishImageCleanup(cleanupKeys);
  res.json({ id, updated: true, media: result });
}
