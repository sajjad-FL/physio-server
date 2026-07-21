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

    /** Platform PhonePe QR image URL for manager UPI collections. */
    phonePeQrUrl: { type: String, trim: true, default: '' },
    phonePeQrUpdatedAt: { type: Date, default: null },

    defaultBookingAmountRupees: { type: Number, min: 0, default: null },
    /** @deprecated Use platformCommissionPerSessionRupees */
    platformCommissionPercent: { type: Number, min: 0, max: 100, default: null },
    /** Flat platform commission per session (INR). Null → default / legacy percent conversion. */
    platformCommissionPerSessionRupees: { type: Number, min: 0, default: null },
    distanceSurchargeBaseKm: { type: Number, min: 0, default: null },
    distanceSurchargePerKmRupees: { type: Number, min: 0, default: null },
    homePlanMaxDiscountPercent: { type: Number, min: 0, max: 50, default: null },
    defaultPhysioPricePerSession: { type: Number, min: 0, default: null },
    /** Flat care-manager commission per session (INR). Null → default (0 = disabled). */
    managerCommissionPerSessionRupees: { type: Number, min: 0, default: null },
    /** Flat clinic commission per session (INR). Null → default. */
    clinicCommissionPerSessionRupees: { type: Number, min: 0, default: null },
    /**
     * Default home-session dual split (same shape as technique prices):
     * { totalAmount, withManager: {platform,physio,manager}, withoutManager: {platform,physio,manager:0} }
     */
    defaultSessionPricing: { type: mongoose.Schema.Types.Mixed, default: undefined },
    /**
     * Clinic visit dual split:
     * { totalAmount, withManager: {platform,clinic,manager}, withoutManager: {platform,clinic,manager:0} }
     */
    clinicSessionPricing: { type: mongoose.Schema.Types.Mixed, default: undefined },
    /**
     * Per-technique session prices (INR), keyed by issue name.
     * e.g. { "Cupping Therapy": 800, "Dry Needling": 1000, "Kinesio Taping": 700, "IASTM": 900 }
     */
    techniquePrices: { type: mongoose.Schema.Types.Mixed, default: undefined },
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
