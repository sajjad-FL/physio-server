import mongoose from 'mongoose';

const clinicLedgerEntrySchema = new mongoose.Schema(
  {
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      default: null,
    },
    amount: { type: Number, required: true, min: 0 },
    direction: { type: String, enum: ['credit', 'debit'], default: 'credit' },
    status: {
      type: String,
      enum: ['open', 'batched', 'settled', 'disputed'],
      default: 'open',
    },
    collectedAt: { type: Date, default: () => new Date() },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    note: { type: String, trim: true, default: '' },
    proofUrl: { type: String, trim: true, default: '' },
    settlementBatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClinicSettlementBatch',
      default: null,
    },
    clinicCommissionAmount: { type: Number, min: 0, default: null },
    /** Manager referrer cut when clinicSource=manager_referred (INR). */
    managerCommissionAmount: { type: Number, min: 0, default: null },
    distribution: {
      type: new mongoose.Schema(
        {
          clinicShare: { type: Number, min: 0, default: 0 },
          managerShare: { type: Number, min: 0, default: 0 },
          platformShare: { type: Number, default: 0 },
          distributedAt: { type: Date, default: null },
          skippedReason: { type: String, trim: true, default: '' },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true }
);

clinicLedgerEntrySchema.index({ clinicId: 1, status: 1, createdAt: -1 });

export default mongoose.model('ClinicLedgerEntry', clinicLedgerEntrySchema);
