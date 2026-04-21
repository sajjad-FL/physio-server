import Payment from '../models/Payment.js';
import Booking from '../models/Booking.js';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function toBookingDoc(bookingOrId) {
  if (!bookingOrId) return null;
  if (typeof bookingOrId === 'string') return Booking.findById(bookingOrId);
  return bookingOrId;
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
 * @returns {Promise<{ totalPaid: number, outstanding: number, coveredSessions: number, sessionsCount: number }>}
 */
export async function recomputeBookingPaymentRollup(bookingOrId) {
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

  await booking.save();

  const sessionsCount = Array.isArray(booking.schedule) && booking.schedule.length > 0
    ? booking.schedule.length
    : 1;
  const perSession = Number(booking.amountPerSession || 0) > 0
    ? Number(booking.amountPerSession)
    : (sessionsCount > 0 ? totalAmount / sessionsCount : totalAmount);
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
  const pendingSum = payments
    .filter((p) => ['pending', 'paid', 'collected'].includes(p?.status))
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  const totalPaid = roundMoney2(verifiedSum);
  const totalPending = roundMoney2(pendingSum);
  const outstanding = roundMoney2(Math.max(0, totalAmount - totalPaid));

  const sessionsCount = Array.isArray(booking?.schedule) && booking.schedule.length > 0
    ? booking.schedule.length
    : 1;
  const perSession = Number(booking?.amountPerSession || 0) > 0
    ? Number(booking.amountPerSession)
    : (sessionsCount > 0 ? totalAmount / sessionsCount : totalAmount);
  const coveredSessions = perSession > 0
    ? Math.min(sessionsCount, Math.floor((totalPaid + 0.009) / perSession))
    : (totalPaid >= totalAmount ? sessionsCount : 0);

  const unlockedSessions = computeUnlockedSessions(sessionsCount, totalPaid, totalAmount);

  return {
    totalAmount,
    totalPaid,
    totalPending,
    outstanding,
    coveredSessions,
    unlockedSessions,
    sessionsCount,
    amountPerSession: roundMoney2(perSession),
  };
}

/**
 * Percentage-based session unlock rule.
 *
 * - N = 1: fully paid unlocks the single session.
 * - floor(0.4 * N) >= 2 (roughly N >= 5): zones 40/20/40.
 *     freeZone = floor(0.4 * N) — unlocked at 0% paid.
 *     Any partial payment opens the middle 20% (N - freeZone total).
 *     Full payment opens the final freeZone.
 * - Otherwise (N = 2, 3, 4): session #1 always free; remaining sessions
 *   unlock proportionally via floor(paidPercent * N); final session always
 *   requires 100% paid.
 *
 * Returns the count of sessions whose ordinal (1-indexed) is currently
 * unlocked for completion.
 *
 * @param {number} sessionsCount
 * @param {number} totalPaid
 * @param {number} totalAmount
 */
export function computeUnlockedSessions(sessionsCount, totalPaid, totalAmount) {
  const n = Math.floor(Number(sessionsCount) || 0);
  if (n <= 0) return 0;
  const paid = Number(totalPaid) || 0;
  const total = Number(totalAmount) || 0;
  const pct = total > 0 ? paid / total : 0;
  const fullyPaid = pct + 1e-6 >= 1;
  if (n === 1) return fullyPaid ? 1 : 0;
  const freeZone = Math.floor(0.4 * n);
  if (freeZone >= 2) {
    if (fullyPaid) return n;
    if (paid > 0) return n - freeZone;
    return freeZone;
  }
  if (fullyPaid) return n;
  const covered = Math.floor(pct * n + 1e-9);
  return Math.min(n - 1, Math.max(1, covered));
}
