
import { S3Client } from '@aws-sdk/client-s3';
import multer from 'multer';

const storage = multer.memoryStorage();

export const productImageUpload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 6,
  },
  fileFilter: (req, file, callback) => {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
    ];

    if (allowedTypes.includes(file.mimetype)) {
      callback(null, true);
    } else {
      callback(
        new Error('Only JPEG, PNG, and WebP images are allowed'),
      );
    }
  },
}).array('uploadimage', 6);

export const s3 = new S3Client({
  region: 'ap-south-1',
});
