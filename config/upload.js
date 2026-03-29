import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { isS3Configured } from '../utils/s3Upload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const uploadsRoot = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(uploadsRoot)) {
  fs.mkdirSync(uploadsRoot, { recursive: true });
}

/** Max size for any physio upload (images + PDFs), in bytes */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const diskStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, uploadsRoot);
  },
  filename(_req, file, cb) {
    const safe = String(file.originalname || 'file').replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

/** When AWS S3 is configured, physio docs are buffered and uploaded to S3; otherwise saved under /uploads. */
export const uploadPhysioDocs = multer({
  storage: isS3Configured() ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

function onboardingFileFilter(_req, file, cb) {
  const ok = /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf';
  cb(ok ? null : new Error('Only images and PDF files are allowed'), ok);
}

export const uploadOnboardingFiles = multer({
  storage: isS3Configured() ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: onboardingFileFilter,
});

const avatarsDir = path.join(uploadsRoot, 'avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

const avatarStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, avatarsDir);
  },
  filename(req, file, cb) {
    const uid = req.auth?.userId ? String(req.auth.userId) : 'user';
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
    cb(null, `${uid}-${Date.now()}${safeExt}`);
  },
});

export const uploadAvatar = multer({
  // Keep profile avatar flow on S3 when configured, same as docs.
  storage: isS3Configured() ? multer.memoryStorage() : avatarStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(_req, file, cb) {
    const ok = /^image\/(jpeg|png|webp)$/.test(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
  },
});
