import mongoose from 'mongoose';

/** Singleton doc `_id: 'singleton'` — platform-wide settings (legacy NDA file fields + qualification declaration). */
const platformSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'singleton' },
    physioNdaTemplateUrl: { type: String, trim: true, default: '' },
    physioNdaOriginalName: { type: String, trim: true, default: '' },
    physioNdaUpdatedAt: { type: Date, default: null },
    /** Admin-editable text; empty means use server default constant. */
    qualificationDeclarationText: { type: String, trim: true, default: '' },
    qualificationDeclarationUpdatedAt: { type: Date, default: null },
  },
  { collection: 'platformsettings' }
);

export default mongoose.model('PlatformSettings', platformSettingsSchema);
