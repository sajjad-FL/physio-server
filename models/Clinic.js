import mongoose from 'mongoose';

const coordinatesSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  { _id: false }
);

const clinicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true, default: '' },
    pincode: { type: String, trim: true, default: null },
    phone: { type: String, trim: true, default: '' },
    coordinates: { type: coordinatesSchema, default: null },
    physioIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Physiotherapist' }],
    staffUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    /** User who receives clinic_commission / withdrawals (usually primary staff). */
    walletUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    isActive: { type: Boolean, default: true },
    payoutUpiId: { type: String, trim: true, default: '' },
    payoutDisplayName: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

clinicSchema.index({ isActive: 1, name: 1 });
clinicSchema.index({ staffUserIds: 1 });

export default mongoose.model('Clinic', clinicSchema);
