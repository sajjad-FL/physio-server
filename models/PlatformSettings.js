import mongoose from 'mongoose';

/** Singleton doc `_id: 'singleton'` — platform-wide files (e.g. physio NDA template). */
const platformSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'singleton' },
    physioNdaTemplateUrl: { type: String, trim: true, default: '' },
    physioNdaOriginalName: { type: String, trim: true, default: '' },
    physioNdaUpdatedAt: { type: Date, default: null },
  },
  { collection: 'platformsettings' }
);

export default mongoose.model('PlatformSettings', platformSettingsSchema);
