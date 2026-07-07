import mongoose from 'mongoose';

const managerLedgerEntrySchema = new mongoose.Schema(
  {
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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
    /** credit = collection owed to platform; debit = refund/adjustment */
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
      ref: 'ManagerSettlementBatch',
      default: null,
    },
    /** Manager commission earned by this collection (INR), computed at record time. Null on pre-feature entries. */
    managerCommissionAmount: { type: Number, min: 0, default: null },
    /** Distribution audit written when the settlement batch is settled. */
    distribution: {
      type: new mongoose.Schema(
        {
          physioShare: { type: Number, min: 0, default: 0 },
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

managerLedgerEntrySchema.index({ managerId: 1, status: 1, createdAt: -1 });

export default mongoose.model('ManagerLedgerEntry', managerLedgerEntrySchema);
