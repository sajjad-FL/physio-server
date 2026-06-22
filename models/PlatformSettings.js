import mongoose from 'mongoose';

const planTierSchema = new mongoose.Schema(
  {
    sessions: { type: Number, required: true },
    defaultDiscountPercent: { type: Number, default: 0 },
    label: { type: String, trim: true, default: '' },
    badge: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const milestoneRowSchema = new mongoose.Schema(
  {
    bySession: { type: Number, required: true },
    minCumPct: { type: Number, required: true },
  },
  { _id: false },
);

/** Singleton doc `_id: 'singleton'` — platform-wide settings. */
const platformSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'singleton' },
    physioNdaTemplateUrl: { type: String, trim: true, default: '' },
    physioNdaOriginalName: { type: String, trim: true, default: '' },
    physioNdaUpdatedAt: { type: Date, default: null },
    qualificationDeclarationText: { type: String, trim: true, default: '' },
    qualificationDeclarationUpdatedAt: { type: Date, default: null },
    referralRewardAmount: { type: Number, default: 300, min: 1 },
    referralRewardAmountUpdatedAt: { type: Date, default: null },
    referralSignupBonusAmount: { type: Number, default: 100, min: 0 },
    referralSignupBonusAmountUpdatedAt: { type: Date, default: null },

    defaultBookingAmountRupees: { type: Number, min: 0, default: null },
    platformCommissionPercent: { type: Number, min: 0, max: 100, default: null },
    distanceSurchargeBaseKm: { type: Number, min: 0, default: null },
    distanceSurchargePerKmRupees: { type: Number, min: 0, default: null },
    homePlanMaxDiscountPercent: { type: Number, min: 0, max: 50, default: null },
    defaultPhysioPricePerSession: { type: Number, min: 0, default: null },
    pricingUpdatedAt: { type: Date, default: null },

    planTiers: { type: [planTierSchema], default: undefined },
    planTiersUpdatedAt: { type: Date, default: null },

    /** Map-like object keyed by session count string, e.g. { "7": [{ bySession, minCumPct }] } */
    planMilestones: { type: mongoose.Schema.Types.Mixed, default: undefined },
    planMilestonesUpdatedAt: { type: Date, default: null },
  },
  { collection: 'platformsettings' },
);

export default mongoose.model('PlatformSettings', platformSettingsSchema);
