import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';
import { HttpError } from '../../shared/errors.js';
import { s3 } from '../../shared/image_upload.js';
import { IMAGE_BUCKET, imageStorageScope, imageUrl } from '../../shared/image-storage.js';
import { ProductImageCleanup } from '../../models/catalog-reliability.model.js';

export const ENROLLMENT_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_ENROLLMENT_FILE_BYTES = 500 * 1024 * 1024;
const tokenKey = new TextEncoder().encode(env.APP_JWT_SECRET);
const sessionAudience = 'enrollment-upload-session';
const fileAudience = 'enrollment-multipart-file';
const receiptAudience = 'enrollment-upload-receipt';

const policies = {
  facilityPhotographs: {
    max: 10,
    size: 10 * 1024 * 1024,
    types: ['image/jpeg', 'image/png', 'image/webp'],
  },
  facilityVideo: { max: 1, size: MAX_ENROLLMENT_FILE_BYTES, types: ['video/mp4'] },
  registrationCertificate: { max: 1 },
  panCard: { max: 1 },
  gstCertificate: { max: 1 },
  addressProof: { max: 1 },
  representativeIdProof: { max: 1 },
  bankAccountDetails: { max: 1 },
  licensesCertificates: { max: 10 },
  digitalSignature: { max: 1, size: 5 * 1024 * 1024, types: ['image/jpeg'] },
};
const documentTypes = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const extension = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

function policy(field) {
  const found = policies[field];
  if (!found) throw new HttpError(400, 'Unknown enrollment upload field');
  return {
    ...found,
    size: found.size ?? 10 * 1024 * 1024,
    types: found.types ?? documentTypes,
  };
}

async function sign(payload, audience, expiresIn) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(tokenKey);
}

async function verify(token, audience) {
  try {
    return (await jwtVerify(token, tokenKey, { audience })).payload;
  } catch {
    throw new HttpError(400, 'Upload token is invalid or expired');
  }
}

function assertS3() {
  if (env.IMAGE_STORAGE_MODE !== 's3')
    throw new HttpError(409, 'Chunk uploads require S3 storage mode');
}

export async function createEnrollmentUploadSession(_req, res) {
  assertS3();
  const sessionId = randomUUID();
  res.status(201).json({
    sessionToken: await sign({ sid: sessionId }, sessionAudience, '24h'),
    chunkSize: ENROLLMENT_CHUNK_BYTES,
    expiresInSeconds: 86400,
  });
}

export async function initiateEnrollmentFile(req, res) {
  assertS3();
  const { sessionToken, field, fileName, contentType, size } = req.validated;
  const { sid } = await verify(sessionToken, sessionAudience);
  const rules = policy(field);
  if (!rules.types.includes(contentType))
    throw new HttpError(400, `${field} does not accept ${contentType}`);
  if (size > rules.size) throw new HttpError(400, `${field} exceeds its size limit`);
  const key = `upload/enrollments/${sid}/${field}/${randomUUID()}.${extension[contentType]}`;
  const result = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: IMAGE_BUCKET,
      Key: key,
      ContentType: contentType,
      CacheControl: 'private, max-age=0, no-cache',
      Metadata: { originalname: encodeURIComponent(fileName).slice(0, 900), field },
    }),
  );
  const partCount = Math.ceil(size / ENROLLMENT_CHUNK_BYTES);
  res.status(201).json({
    fileToken: await sign(
      { sid, field, key, uploadId: result.UploadId, contentType, size, partCount },
      fileAudience,
      '2h',
    ),
    chunkSize: ENROLLMENT_CHUNK_BYTES,
    partCount,
  });
}

export async function getEnrollmentPartUrl(req, res) {
  assertS3();
  const { fileToken, partNumber } = req.validated;
  const upload = await verify(fileToken, fileAudience);
  if (partNumber > upload.partCount)
    throw new HttpError(400, 'partNumber exceeds this file part count');
  const url = await getSignedUrl(
    s3,
    new UploadPartCommand({
      Bucket: IMAGE_BUCKET,
      Key: upload.key,
      UploadId: upload.uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: 900 },
  );
  res.json({ url, partNumber, expiresInSeconds: 900 });
}

function normalizeParts(parts, expected) {
  if (parts.length !== expected)
    throw new HttpError(400, `Expected exactly ${expected} uploaded parts`);
  return parts.map(({ partNumber, etag }, index) => {
    if (partNumber !== index + 1)
      throw new HttpError(400, 'Uploaded parts must be complete and ordered');
    return { PartNumber: partNumber, ETag: etag };
  });
}

async function validateStoredHeader(upload) {
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: IMAGE_BUCKET,
      Key: upload.key,
      Range: 'bytes=0-63',
    }),
  );
  const bytes = Buffer.from(await result.Body.transformToByteArray());
  const valid =
    (upload.contentType === 'image/jpeg' &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (upload.contentType === 'image/png' &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
    (upload.contentType === 'image/webp' &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP') ||
    (upload.contentType === 'video/mp4' && bytes.toString('ascii', 4, 8) === 'ftyp') ||
    (upload.contentType === 'application/pdf' &&
      bytes.toString('ascii', 0, 5) === '%PDF-') ||
    (upload.contentType === 'application/msword' &&
      bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) ||
    (upload.contentType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b);
  if (!valid)
    throw new HttpError(400, 'Uploaded file content does not match its content type');
}

export async function completeEnrollmentFile(req, res) {
  assertS3();
  const { fileToken, parts } = req.validated;
  const upload = await verify(fileToken, fileAudience);
  try {
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: IMAGE_BUCKET,
        Key: upload.key,
        UploadId: upload.uploadId,
        MultipartUpload: { Parts: normalizeParts(parts, upload.partCount) },
      }),
    );
  } catch (error) {
    // A lost HTTP response may make the frontend retry after S3 already completed it.
    // HeadObject below makes that retry idempotent without re-uploading the large file.
    if (error?.name !== 'NoSuchUpload') throw error;
  }
  await ProductImageCleanup.findOrCreate({
    where: { s3_key: upload.key },
    defaults: {
      storage_scope: imageStorageScope,
      not_before: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: IMAGE_BUCKET, Key: upload.key }),
  );
  if (Number(head.ContentLength) !== upload.size) {
    throw new HttpError(409, 'Completed file size does not match the initiated upload');
  }
  await validateStoredHeader(upload);
  const receipt = await sign(
    {
      sid: upload.sid,
      field: upload.field,
      key: upload.key,
      contentType: upload.contentType,
      size: upload.size,
    },
    receiptAudience,
    '24h',
  );
  res.json({ receipt, field: upload.field, url: imageUrl(upload.key) });
}

export async function abortEnrollmentFile(req, res) {
  assertS3();
  const { fileToken } = req.validated;
  const upload = await verify(fileToken, fileAudience);
  try {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: IMAGE_BUCKET,
        Key: upload.key,
        UploadId: upload.uploadId,
      }),
    );
  } catch (error) {
    if (error?.name !== 'NoSuchUpload') throw error;
  }
  res.status(204).end();
}

export async function verifyEnrollmentReceipts(
  receipts,
  { requireCompleteEnrollment = true } = {},
) {
  const decoded = await Promise.all(
    receipts.map((token) => verify(token, receiptAudience)),
  );
  if (!decoded.length)
    throw new HttpError(400, 'At least one upload receipt is required');
  const sessionId = decoded[0].sid;
  if (decoded.some((item) => item.sid !== sessionId))
    throw new HttpError(400, 'All enrollment files must use the same upload session');
  const grouped = {};
  for (const item of decoded) {
    const rules = policy(item.field);
    grouped[item.field] ??= [];
    if (grouped[item.field].length >= rules.max)
      throw new HttpError(400, `Too many ${item.field} uploads`);
    if (grouped[item.field].some((entry) => entry.key === item.key))
      throw new HttpError(400, 'Duplicate upload receipt');
    grouped[item.field].push(item);
  }
  if (requireCompleteEnrollment) {
    for (const field of [
      'registrationCertificate',
      'panCard',
      'addressProof',
      'representativeIdProof',
      'bankAccountDetails',
      'digitalSignature',
    ]) {
      if (grouped[field]?.length !== 1)
        throw new HttpError(400, `Exactly one ${field} upload is required`);
    }
  }
  return { sessionId, grouped };
}
