import PlatformSettings from '../models/PlatformSettings.js';
import { isS3Configured, uploadPhysioAsset } from '../utils/s3Upload.js';

const SINGLETON_ID = 'singleton';

async function persistPlatformTemplate(file) {
  if (file.buffer) {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured but upload used memory storage');
    }
    return uploadPhysioAsset(file.buffer, 'platform/physio-nda', file.originalname, file.mimetype);
  }
  return `/uploads/${file.filename}`;
}

/** Public: physios (and registration) can fetch template metadata for download. */
export async function getPublicPhysioNda(req, res, next) {
  try {
    const doc = await PlatformSettings.findById(SINGLETON_ID).lean();
    const url = String(doc?.physioNdaTemplateUrl || '').trim();
    return res.json({
      templateUrl: url,
      originalName: doc?.physioNdaOriginalName || '',
      requireSignedNda: Boolean(url),
    });
  } catch (err) {
    next(err);
  }
}

export async function getAdminPlatformSettings(req, res, next) {
  try {
    let doc = await PlatformSettings.findById(SINGLETON_ID).lean();
    if (!doc) {
      await PlatformSettings.create({ _id: SINGLETON_ID });
      doc = await PlatformSettings.findById(SINGLETON_ID).lean();
    }
    return res.json({
      physioNdaTemplateUrl: doc?.physioNdaTemplateUrl || '',
      physioNdaOriginalName: doc?.physioNdaOriginalName || '',
      physioNdaUpdatedAt: doc?.physioNdaUpdatedAt || null,
    });
  } catch (err) {
    next(err);
  }
}

export async function uploadPhysioNdaTemplate(req, res, next) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'Upload a PDF or image file (ndaTemplate field)' });
    }

    const url = await persistPlatformTemplate(file);
    const originalName = String(file.originalname || 'nda-template').slice(0, 200);

    const updated = await PlatformSettings.findByIdAndUpdate(
      SINGLETON_ID,
      {
        $set: {
          physioNdaTemplateUrl: url,
          physioNdaOriginalName: originalName,
          physioNdaUpdatedAt: new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({
      message: 'NDA template updated',
      physioNdaTemplateUrl: updated.physioNdaTemplateUrl,
      physioNdaOriginalName: updated.physioNdaOriginalName,
      physioNdaUpdatedAt: updated.physioNdaUpdatedAt,
    });
  } catch (err) {
    next(err);
  }
}
