import SessionNote from '../models/SessionNote.js';
import { getPlatformCommissionPercent } from '../config/commission.js';

/**
 * @param {import('mongoose').Document} booking - Mongoose booking doc (may be modified in memory)
 * @param {{ requireNotesAndSession?: boolean }} opts
 */
export async function releaseEscrowBooking(booking, opts = {}) {
  const requireNotes = opts.requireNotesAndSession !== false;

  if (booking.paymentStatus !== 'held') {
    const err = new Error('Payment is not in held state');
    err.statusCode = 400;
    throw err;
  }

  if (requireNotes) {
    if (booking.sessionStatus !== 'completed') {
      const err = new Error('Session must be completed before release');
      err.statusCode = 400;
      throw err;
    }
    const note = await SessionNote.findOne({ bookingId: booking._id }).lean();
    if (!note) {
      const err = new Error('Clinical notes are required before release');
      err.statusCode = 400;
      throw err;
    }
  }

  const amount = booking.amountPaise || Number(process.env.RAZORPAY_AMOUNT_PAISE) || 50000;
  const feePct = getPlatformCommissionPercent();
  let platformFeePaise;
  const commRupees = booking.payment?.commission;
  if (commRupees != null && Number.isFinite(Number(commRupees))) {
    platformFeePaise = Math.round(Number(commRupees) * 100);
  } else {
    platformFeePaise = Math.round((amount * feePct) / 100);
  }
  const physioPayoutPaise = Math.max(0, amount - platformFeePaise);

  booking.paymentStatus = 'released';
  booking.releaseAt = new Date();
  booking.platformFeePercent = feePct;
  booking.platformFeePaise = platformFeePaise;
  booking.physioPayoutPaise = physioPayoutPaise;
  await booking.save();
  return booking;
}
