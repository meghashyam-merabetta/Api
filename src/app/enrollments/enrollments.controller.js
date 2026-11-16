import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database.js';

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

