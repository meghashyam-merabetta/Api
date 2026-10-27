import { S3Client } from '@aws-sdk/client-s3';
import multer from 'multer';
import { HttpError } from '../../shared/errors.js';
import { MAX_PRODUCT_IMAGES } from '../../shared/product-images.js';

const storage = multer.memoryStorage();

export const productImageUpload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: MAX_PRODUCT_IMAGES,
  },
  fileFilter: (req, file, callback) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

    if (allowedTypes.includes(file.mimetype)) {
      callback(null, true);
    } else {
      callback(new HttpError(400, 'Only JPEG, PNG, and WebP images are allowed'));
    }
  },
}).array('uploadimage', MAX_PRODUCT_IMAGES);

export const s3 = new S3Client({
  region: 'ap-south-1',
});
