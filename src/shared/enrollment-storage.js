import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ProductImageCleanup } from '../models/catalog-reliability.model.js';
import { IMAGE_BUCKET, imageStorageScope, imageUrl } from './image-storage.js';
import { s3 } from './image_upload.js';

const extensions = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'video/mp4': 'mp4',
};

export async function reserveEnrollmentFile(enrollmentId, field, file) {
  const key = `upload/enrollments/${enrollmentId}/${field}/${randomUUID()}.${extensions[file.mimetype]}`;
  await ProductImageCleanup.create({
    s3_key: key,
    storage_scope: imageStorageScope,
    not_before: new Date(Date.now() + 3600000),
  });
  return key;
}

export async function stageEnrollmentFile(key, file, transaction) {
  const journal = await ProductImageCleanup.findByPk(key, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: IMAGE_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'private, max-age=0, no-cache',
      IfNoneMatch: '*',
    }),
  );
  return { url: imageUrl(key), journal };
}
