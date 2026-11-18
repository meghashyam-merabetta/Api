import { QueryTypes } from 'sequelize';
import { randomUUID } from 'node:crypto';
import { sequelize } from '../../config/database.js';
import { HttpError } from '../../shared/errors.js';
import {
  reserveEnrollmentFile,
  stageEnrollmentFile,
} from '../../shared/enrollment-storage.js';
import { signatureAsJpeg } from './enrollment-upload.js';
import { verifyEnrollmentReceipts } from './enrollment-chunks.js';
import { ProductImageCleanup } from '../../models/catalog-reliability.model.js';
import { imageUrl, imageStorageScope } from '../../shared/image-storage.js';

// POST /api/app/enrollments (public)
export async function createEnrollment(req, res) {
  const { poc_client: c, poc_admin: a } = req.validated;

  const created = await sequelize.transaction(async (transaction) => {
    const adminRows = await sequelize.query(
      `INSERT INTO oldagehome.poc_admin (
         registration_number, contact_person_name, designation,
         mobile_number, email_address,
         registration_certificate, pan_card, gst_certificate,
         address_proof, representative_id_proof, bank_account_details,
         licenses_certificates, commercial_agreed, declaration_agreed,
         owner_name, owner_phone, owner_email, digital_signature, status
       ) VALUES (
         :registrationNumber, :contactPersonName, :designation,
         :mobileNumber, :emailAddress,
         :registrationCertificate, :panCard, :gstCertificate,
         :addressProof, :representativeIdProof, :bankAccountDetails,
         CASE
           WHEN CAST(:licensesCertificates AS jsonb) IS NULL THEN NULL
           ELSE ARRAY(SELECT jsonb_array_elements_text(CAST(:licensesCertificates AS jsonb)))
         END,
         :commercialAgreed, :declarationAgreed,
         :ownerName, :ownerPhone, :ownerEmail, :digitalSignature, 'INACTIVE'
       )
       RETURNING id, status`,
      {
        replacements: {
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
        },
        type: QueryTypes.SELECT,
        transaction,
      },
    );

    const { id, status } = adminRows[0];

    await sequelize.query(
      `INSERT INTO oldagehome.poc_client (
         id, home_name, year_established, organization_type,
         address, city, state, pin_code, website,
         total_capacity, current_residents,
         medical_facilities, services_offered, facility_pricing,
         facility_photographs, facility_video, status
       ) VALUES (
         :id, :homeName, :yearEstablished, :organizationType,
         :address, :city, :state, :pinCode, :website,
         :totalCapacity, :currentResidents,
         CAST(:medicalFacilities AS jsonb),
         CAST(:servicesOffered AS jsonb),
         CAST(:facilityPricing AS jsonb),
         ARRAY(SELECT jsonb_array_elements_text(CAST(:facilityPhotographs AS jsonb))),
         :facilityVideo, 'INACTIVE'
       )`,
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

    return { id, status };
  });

  res.status(201).json(created);
}

const requiredUploads = [
  'registrationCertificate',
  'panCard',
  'addressProof',
  'representativeIdProof',
  'bankAccountDetails',
  'digitalSignature',
];

// POST /api/app/enrollments/with-files (public multipart form)
export async function createEnrollmentWithFiles(req, res) {
  const { poc_client: c, poc_admin: a } = req.validated;
  const uploads = { ...(req.files ?? {}) };
  for (const field of requiredUploads) {
    if (uploads[field]?.length !== 1)
      throw new HttpError(400, `Upload exactly one ${field} file`);
  }
  if ((uploads.facilityPhotographs?.length ?? 0) > 10)
    throw new HttpError(400, 'Upload at most 10 facilityPhotographs files');
  uploads.digitalSignature = [await signatureAsJpeg(uploads.digitalSignature[0])];

  const id = randomUUID();
  const reserved = new Map();
  for (const [field, files] of Object.entries(uploads)) {
    reserved.set(
      field,
      await Promise.all(files.map((file) => reserveEnrollmentFile(id, field, file))),
    );
  }

  const stored = await sequelize.transaction(async (transaction) => {
    const urls = {};
    for (const [field, files] of Object.entries(uploads)) {
      urls[field] = [];
      for (const [index, file] of files.entries()) {
        const staged = await stageEnrollmentFile(
          reserved.get(field)[index],
          file,
          transaction,
        );
        urls[field].push(staged.url);
        await staged.journal.destroy({ transaction });
      }
    }

    await sequelize.query(
      `INSERT INTO oldagehome.poc_admin (
         id, registration_number, contact_person_name, designation,
         mobile_number, email_address,
         registration_certificate, pan_card, gst_certificate,
         address_proof, representative_id_proof, bank_account_details,
         licenses_certificates, commercial_agreed, declaration_agreed,
         owner_name, owner_phone, owner_email, digital_signature, status
       ) VALUES (
         :id, :registrationNumber, :contactPersonName, :designation,
         :mobileNumber, :emailAddress,
         :registrationCertificate, :panCard, :gstCertificate,
         :addressProof, :representativeIdProof, :bankAccountDetails,
         CASE WHEN CAST(:licensesCertificates AS jsonb) IS NULL THEN NULL
              ELSE ARRAY(SELECT jsonb_array_elements_text(CAST(:licensesCertificates AS jsonb))) END,
         :commercialAgreed, :declarationAgreed,
         :ownerName, :ownerPhone, :ownerEmail, :digitalSignature, 'INACTIVE'
       )`,
      {
        replacements: {
          id,
          registrationNumber: a.registrationNumber,
          contactPersonName: a.contactPersonName,
          designation: a.designation,
          mobileNumber: a.mobileNumber,
          emailAddress: a.emailAddress,
          registrationCertificate: urls.registrationCertificate[0],
          panCard: urls.panCard[0],
          gstCertificate: urls.gstCertificate?.[0] ?? null,
          addressProof: urls.addressProof[0],
          representativeIdProof: urls.representativeIdProof[0],
          bankAccountDetails: urls.bankAccountDetails[0],
          licensesCertificates: urls.licensesCertificates
            ? JSON.stringify(urls.licensesCertificates)
            : null,
          commercialAgreed: a.commercialAgreed,
          declarationAgreed: a.declarationAgreed,
          ownerName: a.ownerName,
          ownerPhone: a.ownerPhone,
          ownerEmail: a.ownerEmail,
          digitalSignature: urls.digitalSignature[0],
        },
        transaction,
      },
    );

    await sequelize.query(
      `INSERT INTO oldagehome.poc_client (
         id, home_name, year_established, organization_type,
         address, city, state, pin_code, website,
         total_capacity, current_residents,
         medical_facilities, services_offered, facility_pricing,
         facility_photographs, facility_video, status
       ) VALUES (
         :id, :homeName, :yearEstablished, :organizationType,
         :address, :city, :state, :pinCode, :website,
         :totalCapacity, :currentResidents,
         CAST(:medicalFacilities AS jsonb), CAST(:servicesOffered AS jsonb),
         CAST(:facilityPricing AS jsonb),
         ARRAY(SELECT jsonb_array_elements_text(CAST(:facilityPhotographs AS jsonb))),
         :facilityVideo, 'INACTIVE'
       )`,
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
          facilityPhotographs: JSON.stringify(urls.facilityPhotographs ?? []),
          facilityVideo: urls.facilityVideo?.[0] ?? null,
        },
        transaction,
      },
    );
    return { id, status: 'INACTIVE' };
  });

  res.status(201).json(stored);
}

// POST /api/app/enrollments/with-uploaded-files
export async function createEnrollmentFromReceipts(req, res) {
  const { payload, receipts } = req.validated;
  const { poc_client: c, poc_admin: a } = payload;
  const { sessionId: id, grouped } = await verifyEnrollmentReceipts(receipts);
  const urls = Object.fromEntries(
    Object.entries(grouped).map(([field, files]) => [
      field,
      files.map(({ key }) => imageUrl(key)),
    ]),
  );

  const stored = await sequelize.transaction(async (transaction) => {
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

    await sequelize.query(
      `INSERT INTO oldagehome.poc_admin (
         id, registration_number, contact_person_name, designation,
         mobile_number, email_address, registration_certificate, pan_card,
         gst_certificate, address_proof, representative_id_proof,
         bank_account_details, licenses_certificates, commercial_agreed,
         declaration_agreed, owner_name, owner_phone, owner_email,
         digital_signature, status
       ) VALUES (
         :id, :registrationNumber, :contactPersonName, :designation,
         :mobileNumber, :emailAddress, :registrationCertificate, :panCard,
         :gstCertificate, :addressProof, :representativeIdProof,
         :bankAccountDetails,
         CASE WHEN CAST(:licensesCertificates AS jsonb) IS NULL THEN NULL
              ELSE ARRAY(SELECT jsonb_array_elements_text(CAST(:licensesCertificates AS jsonb))) END,
         :commercialAgreed, :declarationAgreed, :ownerName, :ownerPhone,
         :ownerEmail, :digitalSignature, 'INACTIVE'
       )`,
      {
        replacements: {
          id,
          registrationNumber: a.registrationNumber,
          contactPersonName: a.contactPersonName,
          designation: a.designation,
          mobileNumber: a.mobileNumber,
          emailAddress: a.emailAddress,
          registrationCertificate: urls.registrationCertificate[0],
          panCard: urls.panCard[0],
          gstCertificate: urls.gstCertificate?.[0] ?? null,
          addressProof: urls.addressProof[0],
          representativeIdProof: urls.representativeIdProof[0],
          bankAccountDetails: urls.bankAccountDetails[0],
          licensesCertificates: urls.licensesCertificates
            ? JSON.stringify(urls.licensesCertificates)
            : null,
          commercialAgreed: a.commercialAgreed,
          declarationAgreed: a.declarationAgreed,
          ownerName: a.ownerName,
          ownerPhone: a.ownerPhone,
          ownerEmail: a.ownerEmail,
          digitalSignature: urls.digitalSignature[0],
        },
        transaction,
      },
    );

    await sequelize.query(
      `INSERT INTO oldagehome.poc_client (
         id, home_name, year_established, organization_type, address, city,
         state, pin_code, website, total_capacity, current_residents,
         medical_facilities, services_offered, facility_pricing,
         facility_photographs, facility_video, status
       ) VALUES (
         :id, :homeName, :yearEstablished, :organizationType, :address, :city,
         :state, :pinCode, :website, :totalCapacity, :currentResidents,
         CAST(:medicalFacilities AS jsonb), CAST(:servicesOffered AS jsonb),
         CAST(:facilityPricing AS jsonb),
         ARRAY(SELECT jsonb_array_elements_text(CAST(:facilityPhotographs AS jsonb))),
         :facilityVideo, 'INACTIVE'
       )`,
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
          facilityPhotographs: JSON.stringify(urls.facilityPhotographs ?? []),
          facilityVideo: urls.facilityVideo?.[0] ?? null,
        },
        transaction,
      },
    );
    return { id, status: 'INACTIVE' };
  });
  res.status(201).json(stored);
}
