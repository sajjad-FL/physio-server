import mongoose from 'mongoose';
import { generateUniqueReferralCode } from '../utils/referralCode.js';

const coordinatesSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  { _id: false }
);

const addressSchema = new mongoose.Schema(
  {
    text: { type: String, trim: true, default: '' },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  { _id: false }
);

const expoPushTokenSchema = new mongoose.Schema(
  {
    token: { type: String, trim: true, required: true },
    updatedAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    email: { type: String, trim: true, default: '' },
    dob: { type: Date, default: null },
    gender: {
      type: String,
      trim: true,
      enum: ['male', 'female', 'other', 'prefer_not_to_say'],
    },
    isProfileComplete: { type: Boolean, default: false },
    phone: { type: String, required: true, trim: true, unique: true },
    address: { type: addressSchema, default: () => ({}) },
    location: { type: String, trim: true },
    pincode: { type: String, trim: true, default: null },
    coordinates: { type: coordinatesSchema, default: null },
    isVerified: { type: Boolean, default: false },
    /** Set for self-registered physios (email/password). Omitted from queries unless .select('+passwordHash'). */
    passwordHash: { type: String, select: false, default: '' },
    /** True when user may sign in with password before phone OTP verification. */
    hasPasswordLogin: { type: Boolean, default: false },
    role: {
      type: String,
      enum: ['user', 'physio', 'admin', 'care_manager', 'clinic_staff'],
      default: 'user',
    },
    /** @deprecated Legacy multi-role array — run scripts/migrateUserRoles.js and omit on new writes */
    roles: {
      type: [String],
      enum: ['user', 'physio', 'admin', 'care_manager', 'clinic_staff'],
      required: false,
    },
    /** Set when user is clinic_staff — primary clinic membership. */
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      default: null,
    },
    /** Patient registered by clinic staff (walk-in / no app). Links them to that clinic roster. */
    registeredByClinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      default: null,
      index: true,
    },
    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      default: null,
    },
    /** Public path served under /uploads, e.g. /uploads/avatars/… */
    avatarUrl: { type: String, trim: true, default: '' },
    expoPushTokens: { type: [expoPushTokenSchema], default: [] },
    /** Unique share code for patient referrals (6-char uppercase alphanumeric). */
    referralCode: { type: String, trim: true, uppercase: true, default: null },
    /** Set once when registering with another patient's referral code. */
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    /** Platform-funded referral credits (INR) — patients only. */
    walletBalance: { type: Number, default: 0, min: 0 },
    /** UPI ID for commission / earnings payouts (care managers). */
    payoutUpiId: { type: String, trim: true, default: '' },
    payoutDisplayName: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

userSchema.pre('save', async function assignReferralCode(next) {
  if (!this.isNew || this.referralCode) return next();
  try {
    this.referralCode = await generateUniqueReferralCode();
    next();
  } catch (err) {
    next(err);
  }
});

/** Non-empty emails only (phone-only accounts may omit or use empty). */
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string', $gt: '' } } }
);
userSchema.index(
  { referralCode: 1 },
  { unique: true, sparse: true, partialFilterExpression: { referralCode: { $type: 'string', $gt: '' } } }
);

export default mongoose.model('User', userSchema);
