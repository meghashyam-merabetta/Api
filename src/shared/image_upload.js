import { MAX_PRODUCT_IMAGES } from './product-images.js';
import multer from 'multer';
import { S3Client } from '@aws-sdk/client-s3';
import { HttpError } from './errors.js';
import { validateImageContent } from './image-signature.js';

export const MAX_IMAGE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BATCH_BYTES = 10 * 1024 * 1024;
export const s3 = new S3Client({ region: 'ap-south-1' });

// All image endpoints use the same multipart field and validated in-memory files.
// The caller selects its resource-specific file count and aggregate size limit.
export function createImageUpload({
  field = 'uploadimage',
  maxFiles = 1,
  maxFileBytes = MAX_IMAGE_FILE_BYTES,
  maxTotalBytes = maxFileBytes,
} = {}) {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileBytes, files: maxFiles, fields: 0 },
    fileFilter: (_req, file, callback) => {
      if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
        callback(null, true);
      } else {
        callback(new HttpError(400, 'Only JPEG, PNG, and WebP images are allowed'));
      }
    },
  }).array(field, maxFiles);

  return (req, res, next) => {
    parse(req, res, (error) => {
      if (error) return next(new HttpError(400, error.message));
      try {
        const files = req.files ?? [];
        if (!files.length)
          throw new HttpError(400, `Upload at least one image using ${field}`);
        if (files.reduce((total, file) => total + file.size, 0) > maxTotalBytes) {
          throw new HttpError(
            400,
            `Total image size cannot exceed ${maxTotalBytes / (1024 * 1024)} MB`,
          );
        }
        files.forEach(validateImageContent);
        next();
      } catch (validationError) {
        next(validationError);
      }
    });
  };
}

export const productImageUpload = createImageUpload({
  maxFiles: MAX_PRODUCT_IMAGES,
  maxTotalBytes: MAX_IMAGE_BATCH_BYTES,
});
