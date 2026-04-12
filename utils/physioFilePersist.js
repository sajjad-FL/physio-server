import { isS3Configured, uploadPhysioAsset } from './s3Upload.js';

/**
 * @param {Express.Multer.File} file
 * @param {string} physioId
 * @param {string} subpath - folder segment under physio/{id}/
 */
export async function persistPhysioUploadFile(file, physioId, subpath) {
  if (file.buffer) {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured but upload used memory storage');
    }
    return uploadPhysioAsset(file.buffer, `physio/${physioId}/${subpath}`, file.originalname, file.mimetype);
  }
  return `/uploads/${file.filename}`;
}
