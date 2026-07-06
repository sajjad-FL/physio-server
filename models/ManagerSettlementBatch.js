import mongoose from 'mongoose';

const managerSettlementBatchSchema = new mongoose.Schema(
  {
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    ledgerEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ManagerLedgerEntry' }],
    expectedAmount: { type: Number, required: true, min: 0 },
    settledAmount: { type: Number, required: true, min: 0 },
    settlementMethod: { type: String, trim: true, default: 'cash_handoff' },
    notes: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: ['open', 'settled', 'disputed'],
      default: 'open',
    },
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    settledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('ManagerSettlementBatch', managerSettlementBatchSchema);
