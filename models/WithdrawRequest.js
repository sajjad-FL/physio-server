import mongoose from 'mongoose';

const withdrawRequestSchema = new mongoose.Schema(
  {
    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      required: true,
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
  },
  { timestamps: true }
);

withdrawRequestSchema.index({ physioId: 1, status: 1 });

export default mongoose.model('WithdrawRequest', withdrawRequestSchema);
