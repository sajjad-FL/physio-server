import mongoose from 'mongoose';

/**
 * Ledger lines — balances are derived: sum(credits) − sum(debits) on posted rows.
 * Types: online | offline | settlement (refunds use type online/offline with direction debit + meta.reason).
 */
const transactionSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
      index: true,
    },
    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['online', 'offline', 'settlement', 'withdrawal'],
      required: true,
    },
    /** INR — amount for this leg (gross, commission, settlement payment, or reversal). */
    totalAmount: { type: Number, required: true, min: 0 },
    commission: { type: Number, default: 0 },
    physioEarning: { type: Number, default: 0 },
    direction: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
    },
    status: {
      type: String,
      enum: ['posted', 'reversed', 'cancelled'],
      default: 'posted',
      index: true,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

transactionSchema.index({ physioId: 1, createdAt: -1 });
// Widened to include `meta.paymentId` so multi-installment bookings can post
// one credit/commission pair per Payment. Legacy rows without paymentId still
// dedupe correctly because Mongo treats missing keys as null during indexing.
transactionSchema.index(
  { bookingId: 1, physioId: 1, type: 1, direction: 1, 'meta.leg': 1, 'meta.paymentId': 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'posted', 'meta.leg': { $type: 'string' } },
    name: 'uniq_posted_leg_per_payment',
  }
);

export default mongoose.model('Transaction', transactionSchema);
