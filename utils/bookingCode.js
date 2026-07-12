import Counter from '../models/Counter.js';

const BOOKING_COUNTER_ID = 'booking';

/**
 * Atomically allocate the next global booking sequence and build a display code.
 * Format: `{year}-{seq}` e.g. `2026-101` — year is creation year; seq never resets.
 *
 * @param {Date} [at]
 * @returns {Promise<{ bookingSeq: number, bookingCode: string }>}
 */
export async function allocateBookingCode(at = new Date()) {
  const doc = await Counter.findByIdAndUpdate(
    BOOKING_COUNTER_ID,
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  const bookingSeq = Number(doc.seq);
  const year = (at instanceof Date ? at : new Date(at)).getFullYear();
  return {
    bookingSeq,
    bookingCode: `${year}-${bookingSeq}`,
  };
}

/**
 * Ensure the booking counter is at least `minSeq` (used after backfill).
 * @param {number} minSeq
 */
export async function ensureBookingCounterAtLeast(minSeq) {
  const n = Math.max(0, Number(minSeq) || 0);
  if (n <= 0) return;
  const existing = await Counter.findById(BOOKING_COUNTER_ID).lean();
  const current = Number(existing?.seq) || 0;
  if (n > current) {
    await Counter.findByIdAndUpdate(BOOKING_COUNTER_ID, { $set: { seq: n } }, { upsert: true });
  }
}
