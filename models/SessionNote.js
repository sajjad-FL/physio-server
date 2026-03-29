import mongoose from 'mongoose';

const sessionNoteSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      unique: true,
    },
    symptoms: { type: String, trim: true, default: '' },
    diagnosis: { type: String, trim: true, default: '' },
    treatmentPlan: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model('SessionNote', sessionNoteSchema);
