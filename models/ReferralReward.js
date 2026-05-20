import mongoose from 'mongoose';

const referralRewardSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    referredUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
    },
    amount: { type: Number, default: 300, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'credited'],
      default: 'pending',
    },
    creditedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('ReferralReward', referralRewardSchema);
