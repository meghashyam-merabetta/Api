import multer from 'multer';
import sharp from 'sharp';
import { HttpError } from '../../shared/errors.js';
import { validateImageContent } from '../../shared/image-signature.js';

export const ENROLLMENT_FILE_FIELDS = [
  { name: 'facilityPhotographs', maxCount: 10 },
  { name: 'facilityVideo', maxCount: 1 },
  { name: 'registrationCertificate', maxCount: 1 },
  { name: 'panCard', maxCount: 1 },
  { name: 'gstCertificate', maxCount: 1 },
  { name: 'addressProof', maxCount: 1 },
  { name: 'representativeIdProof', maxCount: 1 },
  { name: 'bankAccountDetails', maxCount: 1 },
  { name: 'licensesCertificates', maxCount: 10 },
  { name: 'digitalSignature', maxCount: 1 },
];

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const documentTypes = new Set([
  ...imageTypes,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const documentFields = new Set([
  'registrationCertificate',
  'panCard',
  'gstCertificate',
  'addressProof',
  'representativeIdProof',
  'bankAccountDetails',
  'licensesCertificates',
]);
const MB = 1024 * 1024;

function validatePdf(file) {
  if (
    file.buffer.length < 8 ||
    file.buffer.toString('ascii', 0, 5) !== '%PDF-' ||
    !file.buffer.subarray(-1024).includes(Buffer.from('%%EOF'))
  )
    throw new HttpError(400, `${file.fieldname} content is not a valid PDF`);
}

function validateOfficeDocument(file) {
  const bytes = file.buffer;
  if (file.mimetype === 'application/msword') {
    if (!bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')))
      throw new HttpError(400, `${file.fieldname} content is not a valid DOC file`);
    return;
  }
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    !bytes.includes(Buffer.from('word/'))
  )
    throw new HttpError(400, `${file.fieldname} content is not a valid DOCX file`);
}

function validateMp4(file) {
  const bytes = file.buffer;
  if (
    bytes.length < 12 ||
    bytes.toString('ascii', 4, 8) !== 'ftyp' ||
    !['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(
      bytes.toString('ascii', 8, 12),
    )
  )
    throw new HttpError(400, 'facilityVideo content is not a valid MP4 file');
}

function validateFile(file) {
  if (file.fieldname === 'facilityVideo') {
    if (file.mimetype !== 'video/mp4')
      throw new HttpError(400, 'facilityVideo must be an MP4 file');
    if (file.size > 100 * MB)
      throw new HttpError(400, 'facilityVideo cannot exceed 100 MB');
    validateMp4(file);
    return;
  }
  if (file.fieldname === 'facilityPhotographs' || file.fieldname === 'digitalSignature') {
    if (!imageTypes.has(file.mimetype))
      throw new HttpError(400, `${file.fieldname} must be JPEG, PNG, or WebP`);
    if (file.size > 5 * MB)
      throw new HttpError(400, `${file.fieldname} files cannot exceed 5 MB each`);
    validateImageContent(file);
    return;
  }
  if (documentFields.has(file.fieldname)) {
    if (!documentTypes.has(file.mimetype))
      throw new HttpError(
        400,
        `${file.fieldname} must be PDF, JPEG, PNG, WebP, DOC, or DOCX`,
      );
    if (file.size > 10 * MB)
      throw new HttpError(400, `${file.fieldname} files cannot exceed 10 MB each`);
    if (imageTypes.has(file.mimetype)) validateImageContent(file);
    else if (file.mimetype === 'application/pdf') validatePdf(file);
    else validateOfficeDocument(file);
  }
}

function dataUriFile(value) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(
    value ?? '',
  );
  if (!match)
    throw new HttpError(
      400,
      'digitalSignature must be an image upload or image data URI',
    );
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  const file = {
    fieldname: 'digitalSignature',
    originalname: 'signature',
    mimetype: match[1],
    buffer,
    size: buffer.length,
  };
  validateFile(file);
  return file;
}

const parse = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * MB, files: 29, fields: 1, fieldSize: 12 * MB },
}).fields(ENROLLMENT_FILE_FIELDS);

export function enrollmentMultipart(req, res, next) {
  parse(req, res, async (error) => {
    if (error) return next(new HttpError(400, error.message));
    try {
      if (!req.body.payload)
        throw new HttpError(400, 'Add enrollment JSON in the payload field');
      let payload;
      try {
        payload = JSON.parse(req.body.payload);
      } catch {
        throw new HttpError(400, 'payload must contain valid JSON');
      }
      const files = Object.values(req.files ?? {}).flat();
      if (files.reduce((total, file) => total + file.size, 0) > 150 * MB)
        throw new HttpError(400, 'Total enrollment upload cannot exceed 150 MB');
      files.forEach(validateFile);
      if (!req.files?.digitalSignature?.length && payload?.poc_admin?.digitalSignature) {
        req.files.digitalSignature = [dataUriFile(payload.poc_admin.digitalSignature)];
      }
      if (req.files?.digitalSignature?.length)
        delete payload?.poc_admin?.digitalSignature;
      req.body = payload;
      next();
    } catch (validationError) {
      next(validationError);
    }
  });
}

export async function signatureAsJpeg(file) {
  const buffer = await sharp(file.buffer, { failOn: 'warning' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return {
    ...file,
    mimetype: 'image/jpeg',
    originalname: 'signature.jpg',
    buffer,
    size: buffer.length,
  };
}
