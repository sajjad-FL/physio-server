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
  },
  { timestamps: true }
);

managerLedgerEntrySchema.index({ managerId: 1, status: 1, createdAt: -1 });

export default mongoose.model('ManagerLedgerEntry', managerLedgerEntrySchema);
