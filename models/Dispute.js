import mongoose from 'mongoose';

const disputeSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
    },
    raisedBy: {
      type: String,
      enum: ['user', 'physio'],
      required: true,
    },
    raiserUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    raiserPhysioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      default: null,
    },
    reason: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['open', 'under_review', 'resolved', 'rejected'],
      default: 'open',
    },
    resolution: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

disputeSchema.index({ bookingId: 1 });
disputeSchema.index({ raiserUserId: 1 });
disputeSchema.index({ raiserPhysioId: 1 });
disputeSchema.index({ status: 1 });

export default mongoose.model('Dispute', disputeSchema);
