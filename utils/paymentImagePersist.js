import { isS3Configured, uploadPhysioAsset } from './s3Upload.js';
import { ensureCompressedMulterImage } from './compressImageBuffer.js';

/**
 * Persist an admin PhonePe QR image (multer file → public URL).
 * @param {Express.Multer.File} file
 */
export async function persistPhonePeQrImage(file) {
  if (!file) throw new Error('No file uploaded');
  await ensureCompressedMulterImage(file, { maxEdge: 2048 });
  if (file.buffer) {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured but upload used memory storage');
    }
    return uploadPhysioAsset(file.buffer, 'phonepe', file.originalname, file.mimetype);
  }
  return `/uploads/phonepe/${file.filename}`;
}

/**
 * Persist a manager payment screenshot.
 * @param {Express.Multer.File} file
 * @param {string} bookingId
 */
export async function persistPaymentProofImage(file, bookingId) {
  if (!file) throw new Error('No file uploaded');
  await ensureCompressedMulterImage(file, { maxEdge: 2048 });
  const folder = `payment-proofs/${bookingId || 'unknown'}`;
  if (file.buffer) {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured but upload used memory storage');
    }
    return uploadPhysioAsset(file.buffer, folder, file.originalname, file.mimetype);
  }
  return `/uploads/payment-proofs/${file.filename}`;
}
