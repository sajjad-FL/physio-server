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
    /** INR credited to referrer when a referred friend completes their first booking. */
    referralRewardAmount: { type: Number, default: 300, min: 1 },
    referralRewardAmountUpdatedAt: { type: Date, default: null },
    /** INR credited to new user who registers with a referral code (0 = off). */
    referralSignupBonusAmount: { type: Number, default: 100, min: 0 },
    referralSignupBonusAmountUpdatedAt: { type: Date, default: null },
  },
  { collection: 'platformsettings' }
);

export default mongoose.model('PlatformSettings', platformSettingsSchema);
