import mongoose from 'mongoose';

const coordinatesSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  { _id: false }
);

const documentSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    uploadedAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const qualificationSchema = new mongoose.Schema(
  {
    degree: { type: String, trim: true, default: '' },
    university: { type: String, trim: true, default: '' },
    year: { type: Number, min: 1950, max: 2100, default: null },
    registrationNumber: { type: String, trim: true, default: '' },
    certificateUrl: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const documentUrlsSchema = new mongoose.Schema(
  {
    idProof: { type: String, trim: true, default: '' },
    registrationCertificate: { type: String, trim: true, default: '' },
    selfieWithId: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const onboardingSchema = new mongoose.Schema(
  {
    currentStep: { type: Number, min: 1, max: 5, default: 1 },
    submittedAt: { type: Date, default: null },
  },
  { _id: false }
);

const verificationSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'verified', 'rejected'],
      default: 'pending',
    },
    level: {
      type: String,
      enum: ['basic', 'verified', 'premium'],
      default: 'basic',
    },
    rejectionReason: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const defaultVerification = () => ({
  status: 'pending',
  level: 'basic',
  rejectionReason: '',
});

const physiotherapistSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, default: '' },
    dob: { type: Date, default: null },
    gender: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    avatar: { type: String, trim: true, default: '' },
    qualification: { type: qualificationSchema, default: () => ({}) },
    documentUrls: { type: documentUrlsSchema, default: () => ({}) },
    onboarding: { type: onboardingSchema, default: () => ({ currentStep: 1, submittedAt: null }) },
    verification: { type: verificationSchema, default: defaultVerification },
    serviceType: {
      type: String,
      enum: ['online', 'home', 'both'],
      default: 'both',
    },
    serviceAreas: { type: [String], default: [] },
    specialization: { type: String, required: true, trim: true },
    experience: { type: Number, min: 0, default: 0 },
    pricePerSession: { type: Number, min: 0, default: 500 },
    location: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    coordinates: { type: coordinatesSchema, default: null },
    availability: { type: Boolean, default: true },
    isAvailable: { type: Boolean, default: true },
    documents: { type: [documentSchema], default: [] },
    isVerified: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    verificationStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    verificationNote: { type: String, trim: true, default: '' },
    avgRating: { type: Number, default: 0, min: 0, max: 5 },
    totalReviews: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

physiotherapistSchema.pre('save', function syncAvailability(next) {
  if (this.isModified('availability') && !this.isModified('isAvailable')) {
    this.isAvailable = this.availability;
  } else if (this.isModified('isAvailable') && !this.isModified('availability')) {
    this.availability = this.isAvailable;
  }
  if (this.isModified('verificationStatus') && !this.isModified('status')) {
    this.status = this.verificationStatus;
  } else if (this.isModified('status') && !this.isModified('verificationStatus')) {
    this.verificationStatus = this.status;
  }
  next();
});

export default mongoose.model('Physiotherapist', physiotherapistSchema);
