import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import {
  formatSessionProgressText,
  sanitizeSessionProgress,
  validateSessionProgress,
} from '../utils/formatAssessmentNotes.js';

function formatNotesPayload(notes) {
  if (!notes) {
    return {
      text: '',
      painNow: null,
      functionNow: null,
      painOnMovement: null,
      sleep: null,
      mobility: null,
      vsLastVisit: null,
      homeExercises: null,
      painMeds: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    text: notes.text || '',
    painNow: notes.painNow ?? null,
    functionNow: notes.functionNow ?? null,
    painOnMovement: notes.painOnMovement ?? null,
    sleep: notes.sleep || null,
    mobility: notes.mobility || null,
    vsLastVisit: notes.vsLastVisit || null,
    homeExercises: notes.homeExercises || null,
    painMeds: notes.painMeds || null,
    createdAt: notes.createdAt || null,
    updatedAt: notes.updatedAt || null,
  };
}

function applyProgressToNotesDoc(doc, progress, now) {
  const summary = formatSessionProgressText(progress);
  doc.text = summary || progress.text || '';
  doc.painNow = progress.painNow;
  doc.functionNow = progress.functionNow;
  doc.painOnMovement = progress.painOnMovement;
  doc.sleep = progress.sleep;
  doc.mobility = progress.mobility;
  doc.vsLastVisit = progress.vsLastVisit;
  doc.homeExercises = progress.homeExercises;
  doc.painMeds = progress.painMeds;
  if (!doc.createdAt) doc.createdAt = now;
  doc.updatedAt = now;
}

export async function patchSessionNotes(req, res, next) {
  try {
    const { sessionId } = req.params;

    if (!mongoose.isValidObjectId(sessionId)) {
      return res.status(400).json({ message: 'Invalid session id' });
    }

    if (req.auth?.role === 'admin') {
      return res.status(403).json({ message: 'Admins have read-only access to session notes' });
    }

    const physioId = req.physio?.id;
    if (!physioId) {
      return res.status(403).json({ message: 'Only physiotherapists can edit session notes' });
    }

    const progress = sanitizeSessionProgress(req.body || {});
    const validationError = validateSessionProgress(progress);
    if (validationError) {
      return res.status(400).json({ message: validationError });
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
      applyProgressToNotesDoc(booking.primarySessionNotes, progress, now);
      booking.markModified('primarySessionNotes');
    } else {
      const sub = booking.schedule.id(sessionId);
      if (!sub) {
        return res.status(404).json({ message: 'Session not found' });
      }
      if (!sub.notes) sub.notes = {};
      applyProgressToNotesDoc(sub.notes, progress, now);
    }

    await booking.save();

    const notesDoc = usePrimary ? booking.primarySessionNotes : booking.schedule.id(sessionId).notes;
    return res.json({ notes: formatNotesPayload(notesDoc) });
  } catch (err) {
    next(err);
  }
}
