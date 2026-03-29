import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import SessionNote from '../models/SessionNote.js';

export async function createNotes(req, res, next) {
  try {
    const physioId = req.physio?.id;
    const { bookingId, symptoms, diagnosis, treatmentPlan, notes } = req.body || {};

    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ message: 'Invalid bookingId' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.physioId?.toString() !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const doc = await SessionNote.findOneAndUpdate(
      { bookingId },
      {
        $set: {
          symptoms: String(symptoms || '').trim(),
          diagnosis: String(diagnosis || '').trim(),
          treatmentPlan: String(treatmentPlan || '').trim(),
          notes: String(notes || '').trim(),
          createdBy: physioId,
        },
      },
      { upsert: true, new: true, runValidators: true }
    ).lean();

    return res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
}

export async function getNotesByBooking(req, res, next) {
  try {
    const { bookingId } = req.params;
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(bookingId).lean();
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    const isAdmin = req.admin === true;
    const isPatient = req.user?.id && booking.userId?.toString() === req.user.id;
    const isPhysio = req.physio?.id && booking.physioId?.toString() === req.physio.id;

    if (!isAdmin && !isPatient && !isPhysio) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const note = await SessionNote.findOne({ bookingId }).populate('createdBy', 'name').lean();
    if (!note) {
      return res.status(404).json({ message: 'Notes not found' });
    }

    return res.json(note);
  } catch (err) {
    next(err);
  }
}
