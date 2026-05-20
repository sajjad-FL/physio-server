import mongoose from 'mongoose';

const draftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true },
    issue: { type: String, required: true, trim: true },
    date: { type: String, required: true, trim: true },
    timeSlot: { type: String, required: true, trim: true },
    physioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Physiotherapist', required: true },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  { _id: false }
);

const onlineCheckoutSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    razorpayOrderId: { type: String, required: true, trim: true },
    amountPaise: { type: Number, required: true },
    grossAmountPaise: { type: Number, default: null },
    walletDiscountPaise: { type: Number, default: 0, min: 0 },
    useWalletCredit: { type: Boolean, default: false },
    /** One-time token for Expo Go / no-WebView flows (hosted HTML checkout). */
    hostedToken: { type: String, default: '', trim: true },
    draft: { type: draftSchema, required: true },
    status: {
      type: String,
      enum: ['pending', 'completing', 'completed', 'cancelled'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

onlineCheckoutSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7200 });

export default mongoose.model('OnlineCheckoutSession', onlineCheckoutSessionSchema);
