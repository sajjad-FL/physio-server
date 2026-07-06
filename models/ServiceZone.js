import mongoose from 'mongoose';

const serviceZoneSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    city: { type: String, trim: true, default: '' },
    region: { type: String, trim: true, default: '' },
    pincodes: {
      type: [String],
      default: [],
      validate: {
        validator(arr) {
          return arr.every((p) => /^\d{6}$/.test(String(p)));
        },
        message: 'Each pincode must be a 6-digit string',
      },
    },
    managerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    physioIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Physiotherapist' }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

serviceZoneSchema.index({ pincodes: 1, isActive: 1 });

export default mongoose.model('ServiceZone', serviceZoneSchema);
