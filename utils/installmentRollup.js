import Payment from '../models/Payment.js';
import Booking from '../models/Booking.js';
import { getPlanMilestonesSync } from './pricingConfig.js';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * One session line for installment math: physio base + per-visit distance (home),
 * or an inferred average from total ÷ sessions when base is unset.
 */
export function bookingLinePerSession(booking) {
  const base = Number(booking?.amountPerSession || 0);
  const travel = roundMoney2(Math.max(0, Number(booking?.distanceSurchargeAmount) || 0));
  if (base > 0) {
    return roundMoney2(base + travel);
  }
  const sessionsCount = Array.isArray(booking?.schedule) && booking.schedule.length > 0
    ? booking.schedule.length
    : 1;
  const totalAmount = roundMoney2(Number(booking?.totalAmount || booking?.payment?.amount || 0));
  if (sessionsCount > 0 && totalAmount > 0) {
    return roundMoney2(totalAmount / sessionsCount);
  }
  return 0;
}

function toBookingDoc(bookingOrId) {
  if (!bookingOrId) return null;
  if (typeof bookingOrId.save === 'function') return bookingOrId;
  const id =
    typeof bookingOrId === 'string'
      ? bookingOrId
      : bookingOrId?._id != null
        ? bookingOrId._id
        : bookingOrId;
  if (!id) return null;
  return Booking.findById(id);
}

/**
 * Recompute the cached `totalPaid`, `booking.payment.status`, and
 * `booking.paymentStatus` based on Payment rows for this booking.
 *
 *   - `totalPaid` is the sum of Payment rows in status `verified`.
 *   - `booking.payment.status`:
 *       - `'verified'` when totalPaid >= totalAmount (fully covered),
 *       - `'collected'` when any row is `paid` / `collected` / `verified`,
 *       - otherwise stays `'pending'`.
 *   - `booking.paymentStatus` flips to `'held'` as soon as any verified
 *     installment exists, so downstream code (release escrow) keeps working.
 *
 * Safe to call repeatedly (idempotent).
 *
 * @param {string | import('mongoose').Document} bookingOrId
 * @param {{ session?: import('mongoose').ClientSession }} [opts]
 * @returns {Promise<{ totalPaid: number, outstanding: number, coveredSessions: number, sessionsCount: number }>}
 */
export async function recomputeBookingPaymentRollup(bookingOrId, opts = {}) {
  const { session } = opts;
  const booking = await toBookingDoc(bookingOrId);
  if (!booking) return { totalPaid: 0, outstanding: 0, coveredSessions: 0, sessionsCount: 0 };

  const rows = await Payment.find({ bookingId: booking._id }).lean();
  const verifiedSum = rows
    .filter((r) => r.status === 'verified')
    .reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const anyInFlight = rows.some((r) => ['paid', 'collected', 'verified'].includes(r.status));

  const totalPaid = roundMoney2(verifiedSum);
  const totalAmount = roundMoney2(Number(booking.totalAmount || booking.payment?.amount || 0));
  const outstanding = roundMoney2(Math.max(0, totalAmount - totalPaid));

  booking.totalPaid = totalPaid;
  if (!booking.payment) booking.payment = {};
  if (totalAmount > 0) {
    booking.payment.amount = totalAmount;
  }
  if (totalAmount > 0 && totalPaid + 0.009 >= totalAmount) {
    booking.payment.status = 'verified';
  } else if (anyInFlight) {
    booking.payment.status = 'collected';
  } else {
    booking.payment.status = 'pending';
  }

  if (totalPaid > 0) {
    if (booking.paymentStatus === 'pending' || !booking.paymentStatus) {
      booking.paymentStatus = 'held';
    }
    if (!booking.paidAt) booking.paidAt = new Date();
    if (!booking.heldAt) booking.heldAt = new Date();
  }

  await booking.save(session ? { session } : undefined);

  const sessionsCount = Array.isArray(booking.schedule) && booking.schedule.length > 0
    ? booking.schedule.length
    : 1;
  const perSession = bookingLinePerSession(booking) || (sessionsCount > 0 ? totalAmount / sessionsCount : totalAmount);
  const coveredSessions = perSession > 0
    ? Math.min(sessionsCount, Math.floor((totalPaid + 0.009) / perSession))
    : (totalPaid >= totalAmount ? sessionsCount : 0);

  return { totalPaid, outstanding, coveredSessions, sessionsCount };
}

/**
 * Pure derivation for read APIs — does not mutate the booking.
 *
 * @param {{ totalAmount?: number, amountPerSession?: number, schedule?: Array, totalPaid?: number, payment?: { amount?: number } }} booking
 * @param {Array<{ amount?: number, status?: string }>} payments
 */
export function deriveBookingPaymentSummary(booking, payments = []) {
  const totalAmount = roundMoney2(Number(booking?.totalAmount || booking?.payment?.amount || 0));
  const verifiedSum = payments
    .filter((p) => p?.status === 'verified')
    .reduce((s, p) => s + Number(p.amount || 0), 0);
  // collected = physio-recorded offline cash hand-offs awaiting admin verify
  const collectedSum = payments
    .filter((p) => p?.status === 'collected')
    .reduce((s, p) => s + Number(p.amount || 0), 0);
  // pending / paid = incomplete Razorpay orders (not yet confirmed)
  const pendingSum = payments
    .filter((p) => ['pending', 'paid'].includes(p?.status))
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  const totalPaid = roundMoney2(verifiedSum);
  const totalCollected = roundMoney2(collectedSum);
  const totalPending = roundMoney2(pendingSum);
  // Collectable remaining: exclude verified + in-flight collected/pending so
  // managers cannot double-record while a PhonePe screenshot awaits admin.
  const outstanding = roundMoney2(
    Math.max(0, totalAmount - verifiedSum - collectedSum - pendingSum),
  );

  const sessionsCount = Array.isArray(booking?.schedule) && booking.schedule.length > 0
    ? booking.schedule.length
    : 1;
  const perSession =
    bookingLinePerSession(booking) ||
    (sessionsCount > 0 ? totalAmount / sessionsCount : totalAmount);

  // Effective paid for milestone/coverage purposes: verified + collected (physio cash in hand)
  const effectivePaid = roundMoney2(verifiedSum + collectedSum);
  const coveredSessions = perSession > 0
    ? Math.min(sessionsCount, Math.floor((effectivePaid + 0.009) / perSession))
    : (effectivePaid >= totalAmount ? sessionsCount : 0);

  const effectivePct = totalAmount > 0 ? effectivePaid / totalAmount : 0;
  const milestones = getPlanMilestonesSync(sessionsCount);
  const milestoneStatus = milestones
    ? milestones.map((m) => ({
        bySession: m.bySession,
        requiredPct: m.minCumPct,
        met: effectivePct + 1e-6 >= m.minCumPct,
      }))
    : null;

  return {
    totalAmount,
    totalPaid,
    totalCollected,
    totalPending,
    outstanding,
    coveredSessions,
    // unlockedSessions is set to sessionsCount so legacy UI code that reads
    // this field sees "all sessions unlocked" — enforcement is now milestone-based.
    unlockedSessions: sessionsCount,
    sessionsCount,
    amountPerSession: roundMoney2(perSession),
    milestoneStatus,
  };
}

/**
 * @deprecated Session locking is removed. Use milestone-based gating via
 * getRequiredPctForSession (physio-server/constants/planMilestones.js).
 * Returns sessionsCount so all sessions appear unlocked to legacy callers.
 */
export function computeUnlockedSessions(sessionsCount) {
  return Math.max(0, Math.floor(Number(sessionsCount) || 0));
}
