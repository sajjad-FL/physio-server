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
    roles: {
      type: [String],
      enum: ['user', 'physio', 'admin'],
      default: ['user'],
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

export default mongoose.model('User', userSchema);
