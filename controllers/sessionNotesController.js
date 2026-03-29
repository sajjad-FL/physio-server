import mongoose from 'mongoose';
import Booking from '../models/Booking.js';

function formatNotesPayload(notes) {
  if (!notes) return { text: '', createdAt: null, updatedAt: null };
  return {
    text: notes.text || '',
    createdAt: notes.createdAt || null,
    updatedAt: notes.updatedAt || null,
  };
}

export async function patchSessionNotes(req, res, next) {
  try {
    const { sessionId } = req.params;
    const raw = req.body?.text;
    const text = typeof raw === 'string' ? raw.trim() : '';

    if (!mongoose.isValidObjectId(sessionId)) {
      return res.status(400).json({ message: 'Invalid session id' });
    }

    if (req.auth?.roles?.includes('admin')) {
      return res.status(403).json({ message: 'Admins have read-only access to session notes' });
    }

    const physioId = req.physio?.id;
    if (!physioId) {
      return res.status(403).json({ message: 'Only physiotherapists can edit session notes' });
    }

    let booking = await Booking.findOne({ 'schedule._id': sessionId });
    let usePrimary = false;

    if (!booking) {
      booking = await Booking.findById(sessionId);
      usePrimary = Boolean(booking && (!booking.schedule || booking.schedule.length === 0));
      if (!usePrimary) {
        booking = null;
      }
    }

    if (!booking) {
      return res.status(404).json({ message: 'Session not found' });
    }

    const assignedId = booking.physioId?._id
      ? booking.physioId._id.toString()
      : booking.physioId?.toString?.() || '';
    if (assignedId !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const now = new Date();

    if (usePrimary) {
      if (!booking.primarySessionNotes) booking.primarySessionNotes = {};
      booking.primarySessionNotes.text = text;
      if (!booking.primarySessionNotes.createdAt) {
        booking.primarySessionNotes.createdAt = now;
      }
      booking.primarySessionNotes.updatedAt = now;
    } else {
      const sub = booking.schedule.id(sessionId);
      if (!sub) {
        return res.status(404).json({ message: 'Session not found' });
      }
      if (!sub.notes) sub.notes = {};
      sub.notes.text = text;
      if (!sub.notes.createdAt) {
        sub.notes.createdAt = now;
      }
      sub.notes.updatedAt = now;
    }

    await booking.save();

    const notesDoc = usePrimary ? booking.primarySessionNotes : booking.schedule.id(sessionId).notes;
    return res.json({ notes: formatNotesPayload(notesDoc) });
  } catch (err) {
    next(err);
  }
}
