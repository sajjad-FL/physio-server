import mongoose from 'mongoose';

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
    coordinates: { type: coordinatesSchema, default: null },
    isVerified: { type: Boolean, default: false },
    /** Set for self-registered physios (email/password). Omitted from queries unless .select('+passwordHash'). */
    passwordHash: { type: String, select: false, default: '' },
    /** True when user may sign in with password before phone OTP verification. */
    hasPasswordLogin: { type: Boolean, default: false },
    role: {
      type: String,
      enum: ['user', 'physio', 'admin'],
      default: 'user',
    },
    /** @deprecated Legacy multi-role array — run scripts/migrateUserRoles.js and omit on new writes */
    roles: {
      type: [String],
      enum: ['user', 'physio', 'admin'],
      required: false,
    },
    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      default: null,
    },
    /** Public path served under /uploads, e.g. /uploads/avatars/… */
    avatarUrl: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

/** Non-empty emails only (phone-only accounts may omit or use empty). */
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string', $gt: '' } } }
);

export default mongoose.model('User', userSchema);
