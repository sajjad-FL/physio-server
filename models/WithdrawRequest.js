import mongoose from 'mongoose';

const withdrawRequestSchema = new mongoose.Schema(
  {
    /** Payee: exactly one of physioId / managerId must be set. */
    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      default: null,
      index: true,
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    requestedAt: { type: Date, default: () => new Date() },
    processedAt: { type: Date, default: null },
    note: { type: String, default: '', trim: true, maxlength: 500 },
    payoutReference: { type: String, default: '', trim: true, maxlength: 120 },
    rejectReason: { type: String, default: '', trim: true, maxlength: 500 },
    /** Snapshot of payee UPI at request time (admin pays this ID). */
    payoutUpiId: { type: String, default: '', trim: true, maxlength: 80 },
    payoutDisplayName: { type: String, default: '', trim: true, maxlength: 120 },
  },
  { timestamps: true }
);

withdrawRequestSchema.pre('validate', function requireExactlyOnePayee(next) {
  const hasPhysio = Boolean(this.physioId);
  const hasManager = Boolean(this.managerId);
  if (hasPhysio === hasManager) {
    this.invalidate('physioId', 'Exactly one of physioId or managerId must be set');
  }
  next();
});

withdrawRequestSchema.index({ physioId: 1, status: 1 });
withdrawRequestSchema.index({ managerId: 1, status: 1 });

export default mongoose.model('WithdrawRequest', withdrawRequestSchema);
