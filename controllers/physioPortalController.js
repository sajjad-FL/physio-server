import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Payment from '../models/Payment.js';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { isPhysioPlatformApproved } from '../utils/physioVerification.js';
import { sendSMS, sendWhatsApp } from '../utils/notifications.js';
import {
  notifyAppointmentConfirmedWhatsApp,
  notifyFeedbackSurveyWhatsApp,
} from '../utils/authKeyOtp.js';
import { fireBookingPush, notifyExpoUsers } from '../utils/expoPush.js';
import { creditPhysioWalletOnline } from '../utils/marketplacePayment.js';
import { processReferralRewardOnBookingCompleted } from '../services/referralReward.js';
import {
  deriveBookingPaymentSummary,
} from '../utils/installmentRollup.js';
import { getRequiredPctForSession } from '../constants/planMilestones.js';
import { readPagination, paginationMeta } from '../utils/pagination.js';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const PHYSIO_SLOT_CONFLICT_MSG =
  'You already have another booking in that time slot. Please ask admin to reassign this booking or reschedule one of them.';

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
    const and = [];
    const today = new Date().toISOString().slice(0, 10);
    const status = String(req.query?.status || 'all');
    const service = String(req.query?.service || 'all');
    const date = String(req.query?.date || 'all');
    const workflow = String(req.query?.workflow || 'all');
    const sort = String(req.query?.sort || 'latest');
    const calendarStart = String(req.query?.calendarStart || '');
    const calendarEnd = String(req.query?.calendarEnd || '');
    const calendarMode = /^\d{4}-\d{2}-\d{2}$/.test(calendarStart) &&
      /^\d{4}-\d{2}-\d{2}$/.test(calendarEnd);

    if (status === 'scheduled') query.sessionStatus = { $ne: 'completed' };
    if (status === 'completed') query.sessionStatus = 'completed';
    if (status === 'rescheduled') query.rescheduled = true;
    if (['online', 'home'].includes(service)) query.serviceType = service;

    if (date === 'today') query.date = today;
    if (date === 'upcoming') query.date = { $gt: today };
    if (date === 'past') query.date = { $lt: today };

    if (workflow === 'waiting') {
      query.planStatus = { $in: ['awaiting_consent', 'proposed'] };
    } else if (workflow === 'action') {
      and.push({
        $or: [
          { managerId: null, status: 'assigned' },
          {
            managerId: null,
            serviceType: 'home',
            status: { $in: ['accepted', 'scheduled'] },
            planStatus: { $in: [null, 'requested', 'rejected', 'draft'] },
          },
          { schedule: { $elemMatch: { status: 'scheduled', date: { $lte: today } } } },
        ],
      });
    } else if (workflow === 'active') {
      and.push({
        $or: [
          { planStatus: { $in: ['live', 'approved'] }, sessionStatus: { $ne: 'completed' } },
          { workflowStatus: { $in: ['payment_recorded', 'in_treatment'] } },
          {
            managerId: null,
            status: { $in: ['accepted', 'scheduled'] },
            sessionStatus: { $ne: 'completed' },
          },
        ],
      });
    }

    const search = String(req.query?.search || '').trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(escaped, 'i');
      const userIds = await User.find({ $or: [{ name: rx }, { phone: rx }] }).distinct('_id');
      and.push({
        $or: [
          { issue: rx },
          { bookingCode: rx },
          ...(userIds.length ? [{ userId: { $in: userIds } }] : []),
        ],
      });
    }

    if (calendarMode) {
      and.push({
        $or: [
          { date: { $gte: calendarStart, $lte: calendarEnd } },
          { schedule: { $elemMatch: { date: { $gte: calendarStart, $lte: calendarEnd } } } },
        ],
      });
    }
    if (and.length) query.$and = and;

    const sortSpec =
      sort === 'oldest'
        ? { createdAt: 1 }
        : sort === 'priority'
          ? { date: 1, updatedAt: -1 }
          : { createdAt: -1 };
    const find = Booking.find(query)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
      .sort(sortSpec);
    if (!calendarMode) find.skip(skip).limit(limit);

    const [list, total] = await Promise.all([
      find.lean(),
      Booking.countDocuments(query),
    ]);

    return res.json({
      data: list,
      ...paginationMeta({ page: calendarMode ? 1 : page, limit: calendarMode ? Math.max(1, total) : limit, total }),
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

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.physioId?.toString() !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    /** Care-manager flow: assignment is direct — treat accept as idempotent success. */
    if (booking.managerId && action === 'accept') {
      if (booking.status === 'assigned') {
        booking.status = 'accepted';
        booking.sessionStatus = 'scheduled';
        await booking.save();
      }
      const out = await Booking.findById(id)
        .populate('userId', 'name phone location coordinates')
        .populate('physioId', 'name specialization location phone')
        .lean();
      return res.json(out);
    }
    if (booking.managerId && action === 'reject') {
      return res.status(400).json({
        message: 'This booking is managed by a care manager. Contact admin to reassign.',
      });
    }

    if (action !== 'accept' && action !== 'reject') {
      return res.status(400).json({ message: 'action must be accept or reject' });
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
        const physioName =
          booking.physioId?.name ||
          (await Physiotherapist.findById(booking.physioId).select('name').lean())?.name ||
          'PhysiOkhom';
        await notifyAppointmentConfirmedWhatsApp({
          phone: userPhone,
          name: user?.name || booking.name,
          bookedWith: physioName,
          date: booking.date,
          time: booking.timeSlot,
          booking,
          bookingId: booking._id,
        });
      }
      fireBookingPush(async () => {
        await notifyExpoUsers([userIdForNotify], {
          title: 'Booking accepted',
          body: 'Your physiotherapist accepted the visit. Open the app for details.',
          data: {
            kind: 'assignment_accepted',
            bookingId: String(id),
          },
        });
      });
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
      fireBookingPush(async () => {
        await notifyExpoUsers([userIdForNotify], {
          title: 'Booking update',
          body: 'Your physiotherapist was unavailable. We are assigning someone else.',
          data: {
            kind: 'assignment_rejected',
            bookingId: String(id),
          },
        });
      });
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

/** Home-care / manager flows: collection is not the physio's gate for completing sessions. */
function physioSessionPaymentGateSkipped(booking) {
  if (booking.managerId) return true;
  if (booking.planCreatedByRole === 'care_manager') return true;
  if (booking.serviceType === 'home') return true;
  return false;
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
  // Manager-led workflow: sessions underway → in_treatment; all done → completed.
  if (booking.managerId && booking.workflowStatus) {
    if (hasCompleted && allTerminal) {
      booking.workflowStatus = 'completed';
    } else if (hasCompleted && booking.workflowStatus === 'payment_recorded') {
      booking.workflowStatus = 'in_treatment';
    }
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
 * Milestone-based coverage gate for session state transitions.
 *
 * Skipped for home-care and care-manager flows — managers collect offline payments.
 * Online marketplace bookings still enforce milestones before session completion.
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

  if (physioSessionPaymentGateSkipped(booking)) {
    const summary = payments.length > 0 ? deriveBookingPaymentSummary(booking, payments) : null;
    return { ok: true, summary, ordinal };
  }

  // Determine effective paid amount: verified + collected (physio-recorded offline cash)
  let effectivePaid = 0;
  let totalAmount = roundMoney2(Number(booking.totalAmount || booking.payment?.amount || 0));
  let summary = null;

  if (payments.length > 0) {
    summary = deriveBookingPaymentSummary(booking, payments);
    // Include collected (physio cash in hand) alongside verified so the milestone
    // gate doesn't block session completion while admin verification is pending.
    effectivePaid = roundMoney2((summary.totalPaid || 0) + (summary.totalCollected || 0));
    totalAmount = summary.totalAmount;
  } else {
    // Legacy: no Payment rows — fall back to booking-level payment status
    const offline =
      booking.payment?.mode === 'offline' ||
      (booking.serviceType === 'home' && booking.homePlanPaymentMode === 'offline');
    const isPaid = offline
      ? booking.payment?.status === 'verified'
      : booking.payment?.status === 'paid';
    effectivePaid = isPaid && booking.paymentStatus === 'held' ? totalAmount : 0;
  }

  const paidPct = totalAmount > 0 ? effectivePaid / totalAmount : 0;
  const required = getRequiredPctForSession(sessionsCount, ordinal);

  if (paidPct + 1e-6 < required) {
    const pctNeeded = Math.round(required * 100);
    const pctPaid = Math.round(paidPct * 100);
    const amtNeeded = Math.max(0, Math.round((required - paidPct) * totalAmount * 100) / 100);
    res.status(400).json({
      message: `Session #${ordinal} requires at least ${pctNeeded}% payment (₹${amtNeeded} more needed). Currently ${pctPaid}% paid.`,
      code: 'payment_milestone_not_met',
      paymentSummary: summary ?? null,
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

      const sessionPayments = await Payment.find({
        bookingId: booking._id,
        sessionId: entry._id,
        status: { $in: ['collected', 'verified'] },
      }).lean();
      const paymentAtCompletion = sessionPayments.reduce(
        (s, p) => s + Number(p.amount || 0),
        0,
      );
      entry.patientConfirmed = false;
      entry.patientConfirmedAt = null;
      entry.paymentAtCompletion = roundMoney2(paymentAtCompletion);

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

    if (sessionId) {
      const entry = findScheduleEntry(booking, sessionId);
      const paymentAtCompletion = Number(entry?.paymentAtCompletion || 0);
      const ordinal = gated.ordinal;
      const patientUserId = booking.userId;
      const bookingIdStr = String(booking._id);
      fireBookingPush(async () => {
        const label = ordinal ? `Session ${ordinal}` : 'Your session';
        const payNote =
          paymentAtCompletion > 0 ? ` ₹${paymentAtCompletion.toFixed(2)} collected.` : '';
        await notifyExpoUsers([patientUserId], {
          title: 'Session completed',
          body: `${label} with your physio is done.${payNote} Please confirm.`,
          data: { kind: 'session_completed', bookingId: bookingIdStr },
        });
      });

      try {
        const patient = await User.findById(booking.userId).select('phone').lean();
        if (patient?.phone) {
          await notifyFeedbackSurveyWhatsApp({
            phone: patient.phone,
            sessionLabel: ordinal ? `Session ${ordinal}` : undefined,
            booking,
            bookingId: booking._id,
          });
        }
      } catch (_waErr) {
        // non-fatal
      }
    } else {
      // Single-visit booking completed (no multi-session schedule)
      try {
        const patient = await User.findById(booking.userId).select('phone').lean();
        if (patient?.phone) {
          await notifyFeedbackSurveyWhatsApp({
            phone: patient.phone,
            booking,
            bookingId: booking._id,
          });
        }
      } catch (_waErr) {
        // non-fatal
      }
    }

    if (booking.status === 'completed') {
      processReferralRewardOnBookingCompleted(booking).catch((e) =>
        console.warn('[referral] completeSession:', e?.message || e),
      );
    }

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

    if (booking.status === 'completed') {
      processReferralRewardOnBookingCompleted(booking).catch((e) =>
        console.warn('[referral] markSessionNoShow:', e?.message || e),
      );
    }

    const out = await Booking.findById(booking._id)
      .populate('userId', 'name phone location')
      .populate('physioId', 'name specialization location')
      .lean();

    return res.json(out);
  } catch (err) {
    next(err);
  }
}

/** POST /physio/sos-alert
 *  Body: { message: string, coords: { lat: number, lng: number } | null }
 *  Authenticated physio only.
 *  Fires a push notification to every admin user and returns 200 immediately.
 */
export async function sosAlert(req, res, next) {
  try {
    const { message, coords } = req.body ?? {};

    // Build human-readable location string
    const locationStr = coords?.lat != null
      ? `${Number(coords.lat).toFixed(5)}, ${Number(coords.lng).toFixed(5)}`
      : 'location unavailable';

    const physioName = req.physio?.doc?.name ?? 'A physiotherapist';

    // Find all admin user _ids for push targeting
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const adminIds = adminUsers.map(u => u._id);

    // Fire push — non-blocking, never fails the request
    fireBookingPush(() =>
      notifyExpoUsers(adminIds, {
        title: `🚨 SOS — ${physioName}`,
        body: `${message ?? 'I need assistance at this location.'} · ${locationStr}`,
        data: { type: 'sos_alert', physioId: req.physio.id, coords: coords ?? null },
      })
    );

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
