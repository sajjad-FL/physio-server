import { isS3Configured, uploadPhysioAsset } from './s3Upload.js';

/**
 * @param {Express.Multer.File} file
 * @param {string} productId
 */
export async function persistProductImage(file, productId) {
  if (file.buffer) {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured but upload used memory storage');
    }
    return uploadPhysioAsset(file.buffer, `products/${productId}`, file.originalname, file.mimetype);
  }
  return `/uploads/${file.filename}`;
}

/**
 * @param {Express.Multer.File[]} files
 * @param {string} productId
 */
export async function persistProductImages(files, productId) {
  if (!Array.isArray(files) || !files.length) return [];
  const urls = [];
  for (const file of files) {
    urls.push(await persistProductImage(file, productId));
  }
  return urls;
}

