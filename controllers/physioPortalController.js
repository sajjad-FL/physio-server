import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Payment from '../models/Payment.js';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { isPhysioPlatformApproved } from '../utils/physioVerification.js';
import { sendSMS, sendWhatsApp } from '../utils/notifications.js';
import { creditPhysioWalletOnline } from '../utils/marketplacePayment.js';
import {
  deriveBookingPaymentSummary,
  computeUnlockedSessions,
} from '../utils/installmentRollup.js';

const PHYSIO_SLOT_CONFLICT_MSG =
  'You already have another booking in that time slot. Please ask admin to reassign this booking or reschedule one of them.';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 10));
  return { page, limit, skip: (page - 1) * limit };
}

export async function getMe(req, res, next) {
  try {
    const physio = await Physiotherapist.findById(req.physio.id).lean();
    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json({
      ...physio,
      platformApproved: isPhysioPlatformApproved(physio),
    });
  } catch (err) {
    next(err);
  }
}

export async function getPhysioBookingById(req, res, next) {
  try {
    const physioId = req.physio?.id;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
      .lean();

    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const assignedId = booking.physioId?._id
      ? booking.physioId._id.toString()
      : booking.physioId?.toString?.() || '';
    if (assignedId !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const payments = await Payment.find({ bookingId: booking._id })
      .sort({ createdAt: -1 })
      .lean();
    const paymentSummary = deriveBookingPaymentSummary(booking, payments);

    return res.json({ ...booking, payments, paymentSummary });
  } catch (err) {
    next(err);
  }
}

export async function listMyBookings(req, res, next) {
  try {
    const physioId = req.physio?.id;
    const { page, limit, skip } = readPagination(req.query);
    const query = { physioId };
    const [list, total] = await Promise.all([
      Booking.find(query)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
      .sort({ date: 1, timeSlot: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
      Booking.countDocuments(query),
    ]);

    return res.json({
      data: list,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}

export async function patchAvailability(req, res, next) {
  try {
    const { availability } = req.body || {};
    if (typeof availability !== 'boolean') {
      return res.status(400).json({ message: 'availability boolean is required' });
    }

    const physio = await Physiotherapist.findByIdAndUpdate(
      req.physio.id,
      { availability, isAvailable: availability },
      { new: true }
    ).lean();

    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

export async function respondToAssignment(req, res, next) {
  try {
    const physioId = req.physio?.id;
    const { id } = req.params;
    const action = String(req.body?.action || '').toLowerCase();

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }
    if (action !== 'accept' && action !== 'reject') {
      return res.status(400).json({ message: 'action must be accept or reject' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.physioId?.toString() !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (booking.status !== 'assigned') {
      return res.status(400).json({ message: 'This booking is not awaiting your response' });
    }

    const userIdForNotify = booking.userId;

    if (action === 'accept') {
      const conflict = await Booking.exists({
        _id: { $ne: booking._id },
        physioId,
        date: booking.date,
        timeSlot: booking.timeSlot,
      });
      if (conflict) {
        return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
      }

      booking.status = 'accepted';
      booking.sessionStatus = 'scheduled';
      await booking.save();

      if (booking.paymentStatus === 'held') {
        await creditPhysioWalletOnline(booking);
      }

      const user = await User.findById(userIdForNotify).select('phone name').lean();
      const userPhone = user?.phone;
      if (userPhone) {
        await sendSMS({
          to: userPhone,
          message:
            'Your physiotherapist has accepted your booking. Open your dashboard for visit details.',
        });
        await sendWhatsApp({
          to: userPhone,
          message:
            'Good news — your physiotherapist accepted the booking. Check the app for details.',
        });
      }
    } else {
      await Booking.findByIdAndUpdate(id, {
        physioId: null,
        status: 'pending',
        $unset: { sessionStatus: 1 },
      });

      const user = await User.findById(userIdForNotify).select('phone name').lean();
      const userPhone = user?.phone;
      if (userPhone) {
        await sendSMS({
          to: userPhone,
          message:
            'Your assigned physiotherapist was unavailable. We are re-assigning someone for your visit.',
        });
        await sendWhatsApp({
          to: userPhone,
          message:
            'We could not confirm the previous assignment. Our team will assign another physiotherapist shortly.',
        });
      }
    }

    const out = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
      .lean();

    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function patchLocation(req, res, next) {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: 'lat and lng are required numbers' });
    }

    const physio = await Physiotherapist.findByIdAndUpdate(
      req.physio.id,
      { coordinates: { lat, lng } },
      { new: true }
    ).lean();

    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

function ymdToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Re-compute the booking-level sessionStatus/status rollup from per-session
 * schedule entries. Booking is considered "completed" when every scheduled
 * entry has a terminal state (completed or no_show) AND at least one entry
 * is actually completed. No-show-only plans are not auto-completed.
 *
 * Mutates the given booking document in place.
 */
function rollupBookingSessionStatus(booking) {
  if (!Array.isArray(booking.schedule) || booking.schedule.length === 0) return;
  const entries = booking.schedule;
  const hasCompleted = entries.some((e) => e.status === 'completed');
  const allTerminal = entries.every(
    (e) => e.status === 'completed' || e.status === 'no_show',
  );
  if (hasCompleted && allTerminal) {
    booking.sessionStatus = 'completed';
    booking.status = 'completed';
  }
}

/**
 * Shared guardrails for per-session state transitions initiated by the
 * assigned physio. Returns either { ok: true, booking } or { ok: false, res }
 * where res has already been written to.
 */
async function loadBookingForSessionMutation(req, res) {
  const { bookingId } = req.params;
  if (!mongoose.isValidObjectId(bookingId)) {
    res.status(400).json({ message: 'Invalid booking id' });
    return { ok: false };
  }

  const booking = await Booking.findById(bookingId);
  if (!booking) {
    res.status(404).json({ message: 'Booking not found' });
    return { ok: false };
  }
  if (booking.physioId?.toString() !== req.physio.id) {
    res.status(403).json({ message: 'Forbidden' });
    return { ok: false };
  }

  const canTransition =
    booking.status === 'accepted' ||
    booking.status === 'scheduled' ||
    booking.status === 'completed' ||
    (booking.status === 'assigned' && booking.sessionStatus === 'scheduled');
  if (!canTransition) {
    res.status(400).json({
      message: 'Accept the assignment before marking this session complete',
    });
    return { ok: false };
  }

  return { ok: true, booking };
}

/**
 * Strict coverage gate for session state transitions. Physio can only move
 * session #N if verified Payment rows cover N sessions.
 *
 * Writes a response + returns `{ ok: false }` on failure; otherwise returns
 * `{ ok: true, summary, ordinal }`.
 */
async function enforcePaymentCoverage(booking, sessionId, res) {
  const payments = await Payment.find({ bookingId: booking._id }).lean();
  const hasSchedule = Array.isArray(booking.schedule) && booking.schedule.length > 0;
  const sessionsCount = hasSchedule ? booking.schedule.length : 1;

  let ordinal = 1;
  if (sessionId && hasSchedule) {
    const idx = booking.schedule.findIndex((s) => String(s._id) === String(sessionId));
    if (idx < 0) {
      res.status(404).json({ message: 'Session not found on this booking' });
      return { ok: false };
    }
    ordinal = idx + 1;
  }

  // Back-compat: legacy single-session bookings that went through the atomic
  // /payment/verify flow won't have Payment rows yet. Fall back to the legacy
  // booking-level status check when no installments exist.
  if (payments.length === 0) {
    const offline =
      booking.payment?.mode === 'offline' ||
      (booking.serviceType === 'home' && booking.homePlanPaymentMode === 'offline');
    const isPaid = offline
      ? booking.payment?.status === 'verified'
      : booking.payment?.status === 'paid';
    const totalAmount = Number(booking.totalAmount || booking.payment?.amount || 0);
    const totalPaidLegacy =
      isPaid && booking.paymentStatus === 'held' ? totalAmount : 0;
    const unlocked = computeUnlockedSessions(sessionsCount, totalPaidLegacy, totalAmount);
    if (ordinal > unlocked) {
      res.status(400).json({
        message:
          `Session #${ordinal} is locked. Currently unlocked: up to session #${unlocked} of ${sessionsCount}.`,
        code: 'payment_coverage_insufficient',
      });
      return { ok: false };
    }
    return { ok: true, ordinal };
  }

  const summary = deriveBookingPaymentSummary(booking, payments);
  const unlocked = Number(summary.unlockedSessions || 0);

  if (ordinal > unlocked) {
    const hint =
      unlocked === 0
        ? 'Collect at least one installment before marking any session.'
        : `Currently unlocked: up to session #${unlocked} of ${sessionsCount}. Collect the next installment to open more.`;
    res.status(400).json({
      message: `Session #${ordinal} is locked. ${hint}`,
      code: 'payment_coverage_insufficient',
      paymentSummary: summary,
    });
    return { ok: false };
  }

  return { ok: true, summary, ordinal };
}

function findScheduleEntry(booking, sessionId) {
  if (!sessionId || !Array.isArray(booking.schedule)) return null;
  return booking.schedule.id(sessionId) || null;
}

export async function completeSession(req, res, next) {
  try {
    const loaded = await loadBookingForSessionMutation(req, res);
    if (!loaded.ok) return;
    const { booking } = loaded;
    const { sessionId } = req.params;
    const physioId = req.physio.id;

    const hasSchedule = Array.isArray(booking.schedule) && booking.schedule.length > 0;

    const gated = await enforcePaymentCoverage(booking, sessionId, res);
    if (!gated.ok) return;

    if (sessionId) {
      const entry = findScheduleEntry(booking, sessionId);
      if (!entry) {
        return res.status(404).json({ message: 'Session not found on this booking' });
      }
      if (entry.status === 'completed') {
        return res.status(400).json({ message: 'This session is already completed' });
      }
      if (entry.date && entry.date > ymdToday()) {
        return res.status(400).json({
          message:
            'This session is in the future. Reschedule it to today first if it actually happened.',
        });
      }
      entry.status = 'completed';
      entry.completedAt = new Date();
      entry.completedBy = physioId;
      rollupBookingSessionStatus(booking);
    } else if (hasSchedule) {
      return res.status(400).json({
        message:
          'This booking has multiple sessions; specify which session to complete.',
      });
    } else {
      if (booking.sessionStatus === 'completed') {
        return res.status(400).json({ message: 'This booking is already completed' });
      }
      booking.sessionStatus = 'completed';
      booking.status = 'completed';
    }

    await booking.save();

    const out = await Booking.findById(booking._id)
      .populate('userId', 'name phone location')
      .populate('physioId', 'name specialization location')
      .lean();

    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function markSessionNoShow(req, res, next) {
  try {
    const loaded = await loadBookingForSessionMutation(req, res);
    if (!loaded.ok) return;
    const { booking } = loaded;
    const { sessionId } = req.params;
    const reason = String(req.body?.reason || '').trim().slice(0, 500);

    if (!sessionId) {
      return res.status(400).json({ message: 'Session id is required' });
    }

    const gated = await enforcePaymentCoverage(booking, sessionId, res);
    if (!gated.ok) return;

    const entry = findScheduleEntry(booking, sessionId);
    if (!entry) {
      return res.status(404).json({ message: 'Session not found on this booking' });
    }
    if (entry.status === 'completed') {
      return res.status(400).json({
        message: 'Completed sessions cannot be switched to no-show',
      });
    }
    if (entry.date && entry.date > ymdToday()) {
      return res.status(400).json({
        message: 'Future sessions cannot be marked no-show yet',
      });
    }

    entry.status = 'no_show';
    entry.noShowReason = reason;
    entry.completedAt = null;
    entry.completedBy = null;
    rollupBookingSessionStatus(booking);
    await booking.save();

    const out = await Booking.findById(booking._id)
      .populate('userId', 'name phone location')
      .populate('physioId', 'name specialization location')
      .lean();

    return res.json(out);
  } catch (err) {
    next(err);
  }
}
