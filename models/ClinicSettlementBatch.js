import mongoose from 'mongoose';

const clinicSettlementBatchSchema = new mongoose.Schema(
  {
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    ledgerEntryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ClinicLedgerEntry' }],
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
    clinicCommissionTotal: { type: Number, min: 0, default: 0 },
    managerCommissionTotal: { type: Number, min: 0, default: 0 },
    distributedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('ClinicSettlementBatch', clinicSettlementBatchSchema);
