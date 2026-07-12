import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import Payment from '../models/Payment.js';
import ManagerLedgerEntry from '../models/ManagerLedgerEntry.js';
import ServiceZone from '../models/ServiceZone.js';
import Transaction from '../models/Transaction.js';
import WithdrawRequest from '../models/WithdrawRequest.js';
import { computeManagerCommissionBalance } from '../utils/ledgerBalance.js';
import { previewDistribution } from '../services/managerSettlement.js';
import { isPhysioBookable } from '../utils/physioVerification.js';
import {
  computeDistanceSurcharge,
  getEffectiveManagerCommissionPerSessionSync,
  getManagerCommissionPerSessionSync,
  getTechniqueSplitSync,
  isTechniqueIssue,
} from '../utils/pricingConfig.js';
import { applyHomePlanFields, validateHomePlanInput } from '../utils/homePlan.js';
import { isPlanLive, isAwaitingPatientConsent } from '../utils/planStatus.js';
import {
  formatAssessmentNotesText,
  sanitizeAssessmentData,
  validateAssessmentData,
} from '../utils/formatAssessmentNotes.js';
import { deriveBookingPaymentSummary, recomputeBookingPaymentRollup } from '../utils/installmentRollup.js';
import { fireBookingPush, notifyExpoUsers } from '../utils/expoPush.js';
import { findUserIdForPhysioProfile } from '../utils/expoPush.js';
import { DAILY_SLOTS, todayYMDLocal, isSlotStartInPastForToday, isSlotWithin2HoursForToday } from '../config/slots.js';
import {
  getBookablePhysioCount,
  countActivePrimaryBookingsForSlot,
} from '../utils/slotCapacity.js';
import { allocateBookingCode } from '../utils/bookingCode.js';
import { normalizePincode } from '../utils/pincode.js';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const BOOKING_POPULATE =
  'userId managerId zoneId physioId planCreatedBy physioAssignedBy paymentCollectedBy';

const populateBooking = (q) =>
  q
    .populate('userId', 'name phone location coordinates pincode')
    .populate('managerId', 'name phone')
    .populate('zoneId', 'name pincodes')
    .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
    .lean();

async function loadManagerBooking(id, managerUserId, { admin = false } = {}) {
  if (!mongoose.isValidObjectId(id)) return { error: { status: 400, message: 'Invalid booking id' } };
  const booking = await Booking.findById(id);
  if (!booking) return { error: { status: 404, message: 'Booking not found' } };
  if (!admin && booking.managerId?.toString() !== String(managerUserId)) {
    return { error: { status: 403, message: 'Forbidden' } };
  }
  return { booking };
}

async function computeOutstanding(booking) {
  const rows = await Payment.find({ bookingId: booking._id }).lean();
  const claimed = rows
    .filter((r) => ['pending', 'paid', 'collected', 'verified'].includes(r.status))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalAmount = Number(booking.totalAmount || booking.payment?.amount || 0);
  return roundMoney2(Math.max(0, totalAmount - claimed));
}

async function createLedgerForCollection({
  managerId,
  bookingId,
  paymentId,
  amount,
  managerCommissionAmount = null,
  recordedBy,
  note,
  session,
}) {
  const payload = {
    managerId,
    bookingId,
    paymentId,
    amount,
    managerCommissionAmount,
    direction: 'credit',
    status: 'open',
    collectedAt: new Date(),
    recordedBy,
    note: note || '',
  };
  if (session) {
    const [entry] = await ManagerLedgerEntry.create([payload], { session });
    return entry;
  }
  return ManagerLedgerEntry.create(payload);
}

async function attachPaymentsAndSummary(booking) {
  if (!booking?._id) return { payments: [], paymentSummary: null };
  const payments = await Payment.find({ bookingId: booking._id }).sort({ createdAt: -1 }).lean();
  const shaped = payments.map((p) => ({
    ...p,
    sessionOrdinal:
      p.sessionId && Array.isArray(booking.schedule)
        ? booking.schedule.findIndex((s) => String(s._id) === String(p.sessionId)) + 1 || null
        : null,
  }));
  return {
    payments: shaped,
    paymentSummary: deriveBookingPaymentSummary(booking, payments),
  };
}

function resolveSessionId(sessionIdRaw, booking) {
  if (sessionIdRaw == null || sessionIdRaw === '') return { sessionId: null };
  if (!mongoose.isValidObjectId(sessionIdRaw)) {
    return { error: 'Invalid session id' };
  }
  if (!Array.isArray(booking.schedule) || booking.schedule.length === 0) {
    return { error: 'This booking has no sessions' };
  }
  const entry = booking.schedule.id(sessionIdRaw);
  if (!entry) return { error: 'Session not found on this booking' };
  return { sessionId: entry._id };
}

async function defaultSessionIdForCollection(booking) {
  if (!Array.isArray(booking.schedule) || booking.schedule.length === 0) return null;
  const payments = await Payment.find({ bookingId: booking._id }).lean();
  const summary = deriveBookingPaymentSummary(booking, payments);
  const perSession = Number(summary.amountPerSession || 0);
  const bySession = new Map();
  for (const p of payments.filter((r) => r.status === 'verified' && r.sessionId)) {
    const k = String(p.sessionId);
    bySession.set(k, (bySession.get(k) || 0) + Number(p.amount || 0));
  }
  for (const s of booking.schedule) {
    const paid = bySession.get(String(s._id)) || 0;
    if (perSession <= 0 || paid < perSession - 0.009) return s._id;
  }
  const covered = Number(summary.coveredSessions || 0);
  if (covered < booking.schedule.length) {
    return booking.schedule[covered]._id;
  }
  return booking.schedule[0]._id;
}

async function attachLightPaymentSummaries(bookings) {
  if (!Array.isArray(bookings) || bookings.length === 0) return bookings;
  const ids = bookings.map((b) => b._id);
  const payments = await Payment.find({ bookingId: { $in: ids } }).lean();
  const byBooking = new Map();
  for (const p of payments) {
    const bid = String(p.bookingId);
    if (!byBooking.has(bid)) byBooking.set(bid, []);
    byBooking.get(bid).push(p);
  }
  return bookings.map((b) => {
    const rows = byBooking.get(String(b._id)) || [];
    const full = deriveBookingPaymentSummary(b, rows);
    return {
      ...b,
      paymentSummary: {
        outstanding: full.outstanding,
        totalPaid: full.totalPaid,
        totalAmount: full.totalAmount,
        paymentCollectionStatus: b.paymentCollectionStatus,
      },
    };
  });
}

export async function listManagerBookings(req, res, next) {
  try {
    const managerId = req.user?.id;
    if (!managerId) return res.status(401).json({ message: 'Unauthorized' });

    const { page = 1, limit = 20, workflowStatus } = req.query || {};
    const skip = (Math.max(1, Number(page)) - 1) * Math.min(50, Math.max(1, Number(limit)));
    const take = Math.min(50, Math.max(1, Number(limit)));

    const filter = { managerId, serviceType: 'home' };
    if (workflowStatus) filter.workflowStatus = String(workflowStatus);

    const [items, total] = await Promise.all([
      populateBooking(Booking.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(take)),
      Booking.countDocuments(filter),
    ]);

    const enriched = await attachLightPaymentSummaries(items);

    return res.json({ items: enriched, total, page: Number(page), limit: take });
  } catch (err) {
    next(err);
  }
}

export async function getManagerBooking(req, res, next) {
  try {
    const managerId = req.user?.id;
    const { id } = req.params;
    const loaded = await loadManagerBooking(id, managerId);
    if (loaded.error) return res.status(loaded.error.status).json({ message: loaded.error.message });

    const out = await populateBooking(Booking.findById(id));
    const { payments, paymentSummary } = await attachPaymentsAndSummary(out);
    return res.json({ ...out, payments, paymentSummary });
  } catch (err) {
    next(err);
  }
}

export async function recordAssessment(req, res, next) {
  try {
    const managerId = req.user?.id;
    const { id } = req.params;

    const loaded = await loadManagerBooking(id, managerId);
    if (loaded.error) return res.status(loaded.error.status).json({ message: loaded.error.message });
    const booking = loaded.booking;

    if (booking.carePath === 'technique_managed') {
      return res.status(400).json({
        message: 'Assessment is not required for technique bookings — assign a physiotherapist instead',
      });
    }

    const hasStructured = req.body?.assessmentData != null && typeof req.body.assessmentData === 'object';
    if (hasStructured) {
      const assessmentData = sanitizeAssessmentData(req.body.assessmentData);
      const errMsg = validateAssessmentData(assessmentData);
      if (errMsg) return res.status(400).json({ message: errMsg });
      booking.assessmentData = assessmentData;
      booking.assessmentNotes = formatAssessmentNotesText(assessmentData);
    } else {
      const notes = String(req.body?.assessmentNotes || req.body?.notes || '').trim().slice(0, 5000);
      booking.assessmentNotes = notes;
    }

    booking.assessmentCompletedAt = new Date();
    if (booking.workflowStatus === 'manager_assigned' || !booking.workflowStatus) {
      booking.workflowStatus = 'assessment_done';
    }
    await booking.save();

    const out = await populateBooking(Booking.findById(id));
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function managerCreatePlan(req, res, next) {
  try {
    const managerId = req.user?.id;
    const { id } = req.params;

    const loaded = await loadManagerBooking(id, managerId);
    if (loaded.error) return res.status(loaded.error.status).json({ message: loaded.error.message });
    const booking = loaded.booking;

    if (booking.carePath === 'technique_managed') {
      return res.status(400).json({
        message: 'Care plans are not used for technique bookings — assign a physiotherapist instead',
      });
    }

    if (booking.serviceType !== 'home') {
      return res.status(400).json({ message: 'Plan can be created only for home service' });
    }

    if (isPlanLive(booking.planStatus)) {
      return res.status(400).json({ message: 'Plan cannot be edited after the patient has consented' });
    }

    const isUpdate = isAwaitingPatientConsent(booking.planStatus);

    // Manager sets the patient price freely (may exceed the physio's flat rate —
    // the margin funds the manager commission and platform share).
    const validated = validateHomePlanInput(req.body, { excludeAssessmentDate: booking.date });
    if (validated.error) return res.status(400).json({ message: validated.error });

    const commissionPerSession = getManagerCommissionPerSessionSync();

    // If a physio is already assigned, the discounted patient price must cover
    // his flat rate plus the manager commission.
    if (booking.physioId) {
      const physioRateDoc = await Physiotherapist.findById(booking.physioId).select('pricePerSession').lean();
      const physioRate = Number(physioRateDoc?.pricePerSession);
      if (Number.isFinite(physioRate) && physioRate > 0) {
        const discounted = roundMoney2(
          validated.amountPerSession * (1 - (validated.discountPercent || 0) / 100),
        );
        if (discounted < physioRate + commissionPerSession) {
          return res.status(400).json({
            message: `Patient price ₹${discounted}/session after discount cannot cover the physiotherapist rate ₹${physioRate} + manager commission ₹${commissionPerSession}`,
          });
        }
        booking.physioRatePerSession = physioRate;
      }
    }

    try {
      applyHomePlanFields(booking, {
        ...validated,
        createdBy: managerId,
        createdByRole: 'care_manager',
        planStatus: 'awaiting_consent',
        workflowStatus: 'awaiting_patient_consent',
      });
    } catch (e) {
      return res.status(e.statusCode || 400).json({ message: e.message });
    }

    // Snapshot the flat commission so later collections/settlements use the
    // rate that was in force when this plan was created.
    booking.managerCommissionPerSession = commissionPerSession;

    await booking.save();

    fireBookingPush(async () => {
      await notifyExpoUsers([booking.userId], {
        title: isUpdate ? 'Your care plan was updated' : 'Your care plan is ready',
        body: isUpdate
          ? 'Your care manager updated the plan. Review and consent in the app.'
          : 'Review and consent to your home care plan in the app.',
        data: { kind: 'plan_awaiting_consent', bookingId: String(booking._id) },
      });
    });

    const out = await populateBooking(Booking.findById(id));
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function managerAssignPhysio(req, res, next) {
  try {
    const managerId = req.user?.id;
    const { id } = req.params;
    const { physioId } = req.body || {};

    if (!mongoose.isValidObjectId(physioId)) {
      return res.status(400).json({ message: 'Invalid physiotherapist id' });
    }

    const loaded = await loadManagerBooking(id, managerId);
    if (loaded.error) return res.status(loaded.error.status).json({ message: loaded.error.message });
    const booking = loaded.booking;

    if (!isPlanLive(booking.planStatus)) {
      return res.status(400).json({ message: 'Plan must be live (patient consented) before assigning physio' });
    }

    const physio = await Physiotherapist.findById(physioId).lean();
    if (!physio) return res.status(400).json({ message: 'Physiotherapist not found' });
    if (!isPhysioBookable(physio)) {
      return res.status(400).json({ message: 'That physiotherapist is not approved or not available' });
    }

    if (booking.zoneId) {
      const zone = await ServiceZone.findById(booking.zoneId).select('physioIds').lean();
      if (zone?.physioIds?.length) {
        const allowed = zone.physioIds.some((pid) => String(pid) === String(physioId));
        if (!allowed) {
          return res.status(400).json({ message: 'Physiotherapist is not in this service zone' });
        }
      }
    }

    const conflict = await Booking.exists({
      _id: { $ne: booking._id },
      physioId,
      date: booking.date,
      timeSlot: booking.timeSlot,
    });
    if (conflict) {
      return res.status(409).json({ message: 'This physiotherapist already has another booking in that time slot' });
    }

    // The discounted patient price must cover the physio's flat rate plus the
    // manager commission — otherwise settlement could not pay both.
    const commissionPerSession = getEffectiveManagerCommissionPerSessionSync(booking);
    const physioRate = Number(physio.pricePerSession);
    if (booking.amountPerSession && Number.isFinite(physioRate) && physioRate > 0) {
      const discounted = roundMoney2(
        Number(booking.amountPerSession) * (1 - (booking.discountPercent || 0) / 100),
      );
      if (discounted < physioRate + commissionPerSession) {
        return res.status(400).json({
          message: `Patient price ₹${discounted}/session after discount cannot cover this physiotherapist's rate ₹${physioRate} + manager commission ₹${commissionPerSession}. Pick a physiotherapist with a lower rate or revise the plan.`,
        });
      }
    }

    const patient = await User.findById(booking.userId).select('coordinates').lean();
    const surchargeMeta = computeDistanceSurcharge(patient?.coordinates, physio.coordinates);

    booking.physioId = physioId;
    // Lock the flat payout rate at assignment time (payout basis at settlement).
    booking.physioRatePerSession = Number.isFinite(physioRate) && physioRate > 0 ? physioRate : null;
    // Technique bookings always use Techniques Care manager ₹; home plans keep snapshot.
    if (isTechniqueIssue(booking.issue) || booking.managerCommissionPerSession == null) {
      booking.managerCommissionPerSession = commissionPerSession;
    }
    booking.physioAssignedBy = managerId;
    booking.status = 'accepted';
    booking.sessionStatus = 'scheduled';
    booking.workflowStatus = 'physio_assigned';
    booking.distanceKmAtAssign = surchargeMeta.distanceKmAtAssign;
    booking.distanceExtraKm = surchargeMeta.distanceExtraKm;
    booking.distanceSurchargePerKm = surchargeMeta.distanceSurchargePerKm;
    booking.distanceSurchargeAmount = surchargeMeta.distanceSurchargeAmount;

    if (booking.sessions && booking.amountPerSession) {
      const validated = validateHomePlanInput({
        sessions: booking.sessions,
        amountPerSession: booking.amountPerSession,
        billingType: booking.homePlanBillingType || 'installment',
        paymentMode: booking.homePlanPaymentMode || 'offline',
        schedule: booking.schedule,
      });
      if (!validated.error) {
        try {
          applyHomePlanFields(booking, {
            ...validated,
            createdBy: booking.planCreatedBy || managerId,
            createdByRole: booking.planCreatedByRole || 'care_manager',
            planStatus: booking.planStatus,
            workflowStatus: booking.workflowStatus,
          });
        } catch {
          /* keep assignment even if reprice fails */
        }
      }
    }

    await booking.save();

    fireBookingPush(async () => {
      const physioLoginId = await findUserIdForPhysioProfile(physioId);
      if (!physioLoginId) return;
      await notifyExpoUsers([physioLoginId], {
        title: 'New patient assigned',
        body: `You have been assigned a home visit on ${booking.date} · ${booking.timeSlot}.`,
        data: { kind: 'booking_assigned', bookingId: String(booking._id) },
      });
    });

    const out = await populateBooking(Booking.findById(id));
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function managerRecordCollection(req, res, next) {
  try {
    const managerId = req.user?.id;
    const { id } = req.params;
    const amount = roundMoney2(Number(req.body?.amount));
    const note = String(req.body?.note || '').trim().slice(0, 500);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }

    const loaded = await loadManagerBooking(id, managerId);
    if (loaded.error) return res.status(loaded.error.status).json({ message: loaded.error.message });
    const booking = loaded.booking;

    if (!isPlanLive(booking.planStatus)) {
      return res.status(400).json({ message: 'Plan must be live before recording collection' });
    }

    const outstanding = await computeOutstanding(booking);
    if (outstanding <= 0) {
      return res.status(400).json({ message: 'This booking is already fully paid' });
    }
    if (amount > outstanding + 0.009) {
      return res.status(400).json({ message: `Cannot record more than the pending payment of Rs.${outstanding.toFixed(2)}` });
    }

    let sessionId = null;
    if (req.body?.sessionId != null && req.body?.sessionId !== '') {
      const sessionResolved = resolveSessionId(req.body.sessionId, booking);
      if (sessionResolved.error) {
        return res.status(400).json({ message: sessionResolved.error });
      }
      sessionId = sessionResolved.sessionId;
    } else {
      sessionId = await defaultSessionIdForCollection(booking);
    }

    const paymentPayload = {
      bookingId: booking._id,
      sessionId,
      physioId: booking.physioId,
      userId: booking.userId,
      amount,
      mode: 'offline',
      status: 'verified',
      collectedBy: null,
      collectedAt: new Date(),
      verifiedAt: new Date(),
      note,
      meta: { managerId, recordedByUserId: managerId },
    };

    // Proportional commission accrual: this collection's share of the plan's
    // total flat commission (commissionPerSession × sessions). Paid out when
    // the admin settles the cash hand-off; shown as "pending" until then.
    // Technique bookings use Techniques Care manager ₹ (not Defaults ₹/session).
    const commissionPerSession = getEffectiveManagerCommissionPerSessionSync(booking);
    if (booking.managerCommissionPerSession !== commissionPerSession) {
      booking.managerCommissionPerSession = commissionPerSession;
    }
    const planSessions = Math.max(1, Number(booking.sessions) || booking.schedule?.length || 1);
    const planTotal = Number(booking.totalAmount || 0);
    const managerCommissionAmount =
      planTotal > 0 && commissionPerSession > 0
        ? roundMoney2(amount * ((commissionPerSession * planSessions) / planTotal))
        : 0;

    booking.paymentCollectedBy = managerId;
    booking.paymentCollectionStatus = amount >= outstanding - 0.009 ? 'recorded' : 'partial';
    booking.workflowStatus = 'payment_recorded';
    if (amount >= outstanding - 0.009) {
      booking.paymentStatus = 'held';
      booking.paidAt = booking.paidAt || new Date();
      booking.payment = {
        ...(booking.payment?.toObject?.() || booking.payment || {}),
        mode: 'offline',
        status: 'verified',
        amount: Number(booking.totalAmount || amount),
      };
    }

    let payment;
    let ledger;

    async function persistCollection(session) {
      if (session) {
        [payment] = await Payment.create([paymentPayload], { session });
        ledger = await createLedgerForCollection({
          managerId,
          bookingId: booking._id,
          paymentId: payment._id,
          amount,
          managerCommissionAmount,
          recordedBy: managerId,
          note,
          session,
        });
        await booking.save({ session });
        await recomputeBookingPaymentRollup(booking, { session });
        return;
      }

      payment = await Payment.create(paymentPayload);
      try {
        ledger = await createLedgerForCollection({
          managerId,
          bookingId: booking._id,
          paymentId: payment._id,
          amount,
          managerCommissionAmount,
          recordedBy: managerId,
          note,
        });
        await booking.save();
        await recomputeBookingPaymentRollup(booking);
      } catch (innerErr) {
        await Payment.deleteOne({ _id: payment._id });
        if (ledger?._id) await ManagerLedgerEntry.deleteOne({ _id: ledger._id });
        throw innerErr;
      }
    }

    const mongoSession = await mongoose.startSession();
    try {
      mongoSession.startTransaction();
      await persistCollection(mongoSession);
      await mongoSession.commitTransaction();
    } catch (txnErr) {
      await mongoSession.abortTransaction();
      const txnUnsupported =
        txnErr.code === 20 ||
        /replica set|Transaction numbers are only allowed/i.test(String(txnErr.message || ''));
      if (txnUnsupported) {
        await persistCollection(null);
      } else {
        throw txnErr;
      }
    } finally {
      mongoSession.endSession();
    }

    const out = await populateBooking(Booking.findById(id));
    const { payments, paymentSummary } = await attachPaymentsAndSummary(out);
    return res.status(201).json({ booking: { ...out, payments, paymentSummary }, payment, ledgerEntry: ledger });
  } catch (err) {
    next(err);
  }
}

export async function listManagerLedger(req, res, next) {
  try {
    const managerId = req.user?.id;
    const status = req.query?.status ? String(req.query.status) : undefined;
    const filter = { managerId };
    if (status) filter.status = status;

    const entries = await ManagerLedgerEntry.find(filter)
      .sort({ createdAt: -1 })
      .populate({
        path: 'bookingId',
        select:
          'issue carePath date timeSlot totalAmount sessions schedule userId bookingCode bookingSeq managerCommissionPerSession',
        populate: { path: 'userId', select: 'name phone' },
      })
      .lean();

    const commissionFixes = [];
    const shaped = entries.map((e) => {
      const booking = e.bookingId;
      const patientName =
        booking && typeof booking.userId === 'object' ? booking.userId?.name : null;

      let managerCommissionAmount = e.managerCommissionAmount;
      // Open/batched technique rows may still store Defaults-based cut — show Techniques rate.
      if (
        booking &&
        isTechniqueIssue(booking.issue) &&
        (e.status === 'open' || e.status === 'batched') &&
        e.direction === 'credit'
      ) {
        const perSession = getEffectiveManagerCommissionPerSessionSync(booking);
        const planSessions = Math.max(
          1,
          Number(booking.sessions) || booking.schedule?.length || 1,
        );
        const planTotal = Number(booking.totalAmount || 0);
        const amount = Number(e.amount || 0);
        const corrected =
          planTotal > 0 && perSession > 0
            ? roundMoney2(amount * ((perSession * planSessions) / planTotal))
            : 0;
        if (Number(managerCommissionAmount) !== corrected) {
          managerCommissionAmount = corrected;
          commissionFixes.push({ id: e._id, amount: corrected });
        }
      }

      return {
        ...e,
        managerCommissionAmount,
        bookingRef: booking
          ? {
              id: booking._id,
              issue: booking.issue,
              patientName,
              bookingCode: booking.bookingCode || null,
              bookingSeq: booking.bookingSeq ?? null,
            }
          : null,
      };
    });

    if (commissionFixes.length) {
      await ManagerLedgerEntry.bulkWrite(
        commissionFixes.map((f) => ({
          updateOne: {
            filter: { _id: f.id, status: { $in: ['open', 'batched'] } },
            update: { $set: { managerCommissionAmount: f.amount } },
          },
        })),
      );
    }

    const openTotal = entries
      .filter((e) => e.status === 'open' && e.direction === 'credit')
      .reduce((s, e) => s + Number(e.amount || 0), 0);

    return res.json({ entries: shaped, openTotal: roundMoney2(openTotal) });
  } catch (err) {
    next(err);
  }
}

/**
 * Manager earnings wallet:
 * - pendingCommission — accrued on open/batched collections, paid at settlement
 * - settledCommission / withdrawn / availableBalance — from manager Transaction rows
 * - cashToRemit — collected cash not yet settled with admin (open + batched)
 */
export async function getManagerWallet(req, res, next) {
  try {
    const managerId = req.user?.id;

    const unsettled = await ManagerLedgerEntry.find({
      managerId,
      direction: 'credit',
      status: { $in: ['open', 'batched'] },
    }).lean();

    const preview = await previewDistribution(unsettled);
    const balance = await computeManagerCommissionBalance(managerId);
    const cashToRemit = roundMoney2(unsettled.reduce((s, e) => s + Number(e.amount || 0), 0));
    const totalCollected = await ManagerLedgerEntry.aggregate([
      {
        $match: {
          managerId: new mongoose.Types.ObjectId(String(managerId)),
          direction: 'credit',
          status: { $ne: 'disputed' },
        },
      },
      { $group: { _id: null, sum: { $sum: '$amount' } } },
    ]);
    const pendingWithdraw = await WithdrawRequest.findOne({ managerId, status: 'pending' }).lean();

    return res.json({
      pendingCommission: preview.managerTotal,
      settledCommission: balance.settledCommission,
      withdrawn: balance.withdrawn,
      availableBalance: balance.availableBalance,
      cashToRemit,
      totalCollected: roundMoney2(totalCollected[0]?.sum || 0),
      pendingWithdraw,
    });
  } catch (err) {
    next(err);
  }
}

/** Paginated manager money movements (commission credits + withdrawal debits). */
export async function listManagerWalletTransactions(req, res, next) {
  try {
    const managerId = req.user?.id;
    const page = Math.max(1, Number(req.query?.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query?.limit) || 20));

    const filter = {
      userId: managerId,
      type: { $in: ['manager_commission', 'manager_withdrawal'] },
      status: 'posted',
    };
    const [rows, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({
          path: 'bookingId',
          select: 'issue date timeSlot userId bookingCode bookingSeq',
          populate: { path: 'userId', select: 'name' },
        })
        .lean(),
      Transaction.countDocuments(filter),
    ]);

    return res.json({ transactions: rows, total, page, limit });
  } catch (err) {
    next(err);
  }
}

export async function listManagerZones(req, res, next) {
  try {
    const managerId = req.user?.id;
    const zones = await ServiceZone.find({ isActive: true, managerIds: managerId })
      .select('name city region pincodes physioIds')
      .lean();
    return res.json({ zones });
  } catch (err) {
    next(err);
  }
}

export async function listZonePhysios(req, res, next) {
  try {
    const managerId = req.user?.id;
    const { bookingId } = req.query || {};
    let physioIds = [];

    if (bookingId && mongoose.isValidObjectId(bookingId)) {
      const booking = await Booking.findById(bookingId).select('zoneId managerId').lean();
      if (!booking || booking.managerId?.toString() !== String(managerId)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      if (booking.zoneId) {
        const zone = await ServiceZone.findById(booking.zoneId).select('physioIds').lean();
        physioIds = zone?.physioIds || [];
      }
    } else {
      const zones = await ServiceZone.find({ isActive: true, managerIds: managerId }).select('physioIds').lean();
      const set = new Set();
      for (const z of zones) {
        for (const pid of z.physioIds || []) set.add(String(pid));
      }
      physioIds = [...set];
    }

    const query = physioIds.length
      ? { _id: { $in: physioIds }, verificationStatus: 'approved' }
      : { verificationStatus: 'approved' };

    const physios = await Physiotherapist.find(query)
      .select(
        'name specialization location phone pricePerSession pricePerSessionMax experience avatar coordinates avgRating totalReviews isVerified verificationStatus availability isAvailable',
      )
      .lean();

    return res.json({ physios });
  } catch (err) {
    next(err);
  }
}

/**
 * Manager creates a technique booking (cupping, dry needling, etc.) for the
 * patient on an existing managed case. Always technique_managed under this manager.
 * Multi-session: one booking with a visit schedule; manager may send explicit dates[].
 */
function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export async function managerSuggestTechnique(req, res, next) {
  try {
    const managerId = req.user?.id;
    const { id } = req.params;
    const { issue, timeSlot } = req.body || {};

    const loaded = await loadManagerBooking(id, managerId);
    if (loaded.error) return res.status(loaded.error.status).json({ message: loaded.error.message });
    const source = loaded.booking;

    if (source.serviceType !== 'home') {
      return res.status(400).json({ message: 'Technique bookings are only for home-care patients' });
    }
    if (!source.userId) {
      return res.status(400).json({ message: 'This case has no patient' });
    }

    const techniqueIssue = String(issue || '').trim();
    if (!isTechniqueIssue(techniqueIssue)) {
      return res.status(400).json({
        message: 'Choose Cupping Therapy, Dry Needling, Kinesio Taping, or IASTM',
      });
    }

    let sessions = Number(req.body?.sessions);
    if (!Number.isFinite(sessions)) sessions = 1;
    sessions = Math.round(sessions);
    if (!Number.isInteger(sessions) || sessions < 1 || sessions > 15) {
      return res.status(400).json({ message: 'sessions must be an integer between 1 and 15' });
    }

    const todayYmd = todayYMDLocal();
    const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
    let visitDates = [];
    if (Array.isArray(req.body?.dates) && req.body.dates.length > 0) {
      if (req.body.dates.length !== sessions) {
        return res.status(400).json({ message: 'dates must match the number of sessions' });
      }
      for (const raw of req.body.dates) {
        const d = String(raw || '').trim();
        if (!ymdRe.test(d)) {
          return res.status(400).json({ message: 'Each visit date must be YYYY-MM-DD' });
        }
        if (d < todayYmd) {
          return res.status(400).json({ message: 'Visit dates must be today or in the future' });
        }
        visitDates.push(d);
      }
    } else {
      // Back-compat: single `date` + consecutive days
      const date = String(req.body?.date || '').trim();
      if (!ymdRe.test(date)) {
        return res.status(400).json({ message: 'Provide dates[] for each session, or a starting date' });
      }
      if (date < todayYmd) {
        return res.status(400).json({ message: 'Date must be today or in the future' });
      }
      visitDates = Array.from({ length: sessions }, (_, i) => addDaysYmd(date, i));
    }

    // Per-session times (preferred) or one shared timeSlot for all visits
    let visitTimes = [];
    if (Array.isArray(req.body?.times) && req.body.times.length > 0) {
      if (req.body.times.length !== sessions) {
        return res.status(400).json({ message: 'times must match the number of sessions' });
      }
      for (const raw of req.body.times) {
        const t = String(raw || '').trim();
        if (!DAILY_SLOTS.includes(t)) {
          return res.status(400).json({ message: 'Each visit time must be a valid time slot' });
        }
        visitTimes.push(t);
      }
    } else {
      const normalizedTimeSlot = String(timeSlot || '').trim();
      if (!DAILY_SLOTS.includes(normalizedTimeSlot)) {
        return res.status(400).json({ message: 'timeSlot is not available' });
      }
      visitTimes = Array.from({ length: sessions }, () => normalizedTimeSlot);
    }

    for (let i = 0; i < sessions; i++) {
      const d = visitDates[i];
      const t = visitTimes[i];
      if (d === todayYmd && isSlotStartInPastForToday(t)) {
        return res.status(400).json({
          message: `Session ${i + 1}: this time slot is no longer available`,
        });
      }
      if (d === todayYmd && isSlotWithin2HoursForToday(t)) {
        return res.status(400).json({
          message: `Session ${i + 1}: bookings must be made at least 2 hours in advance`,
        });
      }
    }

    const platformCapacity = await getBookablePhysioCount();
    if (platformCapacity < 1) {
      return res.status(503).json({
        message: 'No verified physiotherapists are available to take new bookings right now',
      });
    }
    for (let i = 0; i < sessions; i++) {
      const alreadyBooked = await countActivePrimaryBookingsForSlot(visitDates[i], visitTimes[i]);
      if (alreadyBooked >= platformCapacity) {
        return res.status(409).json({
          message: `Session ${i + 1}: that date/time is fully booked. Choose another slot.`,
        });
      }
    }

    const patient = await User.findById(source.userId).select('name location pincode coordinates').lean();
    if (!patient) {
      return res.status(400).json({ message: 'Patient account not found' });
    }
    const location = String(patient.location || '').trim();
    if (!location) {
      return res.status(400).json({
        message: 'Patient needs a saved home address before you can book a technique visit',
      });
    }

    const split = getTechniqueSplitSync(techniqueIssue, sessions, { includeManager: true });
    const price = split.amountPerSession;
    const totalAmount = split.amount;
    const pincode =
      normalizePincode(source.pincode) ||
      normalizePincode(patient.pincode) ||
      normalizePincode(location);

    const firstDate = visitDates[0];
    const firstTime = visitTimes[0];
    const schedule = visitDates.map((d, i) => ({
      date: d,
      time: visitTimes[i],
      status: 'scheduled',
    }));

    let booking;
    try {
      const { bookingSeq, bookingCode } = await allocateBookingCode();
      booking = new Booking({
        userId: source.userId,
        physioId: null,
        issue: techniqueIssue,
        date: firstDate,
        timeSlot: firstTime,
        status: 'pending',
        paymentStatus: 'pending',
        serviceType: 'home',
        consentAccepted: true,
        sessions,
        schedule,
        amountPerSession: price,
        totalAmount,
        amountPaise: Math.round(totalAmount * 100),
        bookingSeq,
        bookingCode,
        payment: {
          mode: 'offline',
          status: 'pending',
          amount: split.amount,
          commission: split.commission,
          physioEarning: split.physioEarning,
        },
        carePath: 'technique_managed',
        managerId,
        zoneId: source.zoneId || null,
        pincode: pincode || null,
        managerAssignedAt: new Date(),
        planStatus: 'live',
        planLiveAt: new Date(),
        workflowStatus: 'plan_live',
        managerCommissionPerSession: split.managerPerSession,
        homePlanPaymentMode: 'offline',
        homePlanBillingType: 'full',
      });
      await booking.save();
    } catch (e) {
      if (e?.code === 11000) {
        return res.status(409).json({
          message:
            'Could not save this booking (database conflict). Try another date/slot, or restart the API.',
        });
      }
      throw e;
    }

    fireBookingPush(async () => {
      const sessionPart =
        sessions > 1 ? `${sessions} sessions starting ${firstDate}` : `for ${firstDate}`;
      await notifyExpoUsers([booking.userId], {
        title: 'Technique session booked',
        body: `Your care manager booked ${techniqueIssue} (${sessionPart}). They will assign a physiotherapist.`,
        data: { kind: 'technique_managed', bookingId: String(booking._id) },
      });
    });

    const out = await populateBooking(Booking.findById(booking._id));
    const { payments, paymentSummary } = await attachPaymentsAndSummary(out);
    return res.status(201).json({ ...out, payments, paymentSummary });
  } catch (err) {
    next(err);
  }
}
