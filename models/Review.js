import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema(
  {
    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      required: true,
      index: true,
    },
    userId: {
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
    /**
     * Identifies which session within a multi-session plan this review is for.
     * null means "primary / single-session booking" (legacy rows + non-plan
     * bookings). Enforced uniqueness is (bookingId, sessionId).
     */
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true, default: '', maxlength: 2000 },
  },
  { timestamps: true }
);

reviewSchema.index({ physioId: 1, createdAt: -1 });
reviewSchema.index(
  { bookingId: 1, sessionId: 1 },
  { unique: true, name: 'uniq_review_booking_session' },
);

export default mongoose.model('Review', reviewSchema);
