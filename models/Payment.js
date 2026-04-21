import mongoose from 'mongoose';

/**
 * One document per installment toward a booking. Multiple installments can
 * roll up to cover the booking's total amount, spread across sessions.
 *
 * Online flow: pending (Razorpay order created) -> paid (signature verified)
 *   -> verified (auto).
 * Offline flow: collected (physio recorded cash/UPI) -> verified (admin OK)
 *   or rejected (admin rejected with reason; physio may re-collect).
 */
const paymentSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      index: true,
    },
    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    mode: {
      type: String,
      enum: ['online', 'offline'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'collected', 'verified', 'rejected', 'refunded'],
      required: true,
      index: true,
    },
    /** Physio who recorded the cash collection (offline only). */
    collectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      default: null,
    },
    collectedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },

    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },

    /** Physio's optional note (e.g. "Cash after session 2"). */
    note: { type: String, default: '', trim: true, maxlength: 500 },
    /** Admin's reason when rejecting an offline collection. */
    rejectReason: { type: String, default: '', trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

paymentSchema.index({ bookingId: 1, createdAt: 1 });
paymentSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } }
);

export default mongoose.model('Payment', paymentSchema);
