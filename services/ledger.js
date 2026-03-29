import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import { roundMoney2 } from '../utils/marketplacePayment.js';
import { computeCommissionDue } from '../utils/ledgerBalance.js';

const POSTED = 'posted';

function splitFromBooking(booking) {
  const gross = roundMoney2(Number(booking.payment?.amount ?? 0));
  const commission = roundMoney2(Number(booking.payment?.commission ?? 0));
  const physioEarning = roundMoney2(Number(booking.payment?.physioEarning ?? 0));
  return { gross, commission, physioEarning };
}

/**
 * Idempotent: one posted online credit per booking (physio earning).
 */
export async function postOnlineCredit(booking) {
  const physioId = booking.physioId;
  if (!physioId) return { created: false, reason: 'no_physio' };
  const { gross, commission, physioEarning } = splitFromBooking(booking);
  if (!Number.isFinite(physioEarning) || physioEarning <= 0) return { created: false, reason: 'no_earning' };

  const existing = await Transaction.findOne({
    bookingId: booking._id,
    physioId,
    type: 'online',
    direction: 'credit',
    status: POSTED,
    'meta.leg': 'earning',
  }).lean();
  if (existing) return { created: false, reason: 'duplicate', transactionId: existing._id };

  await Transaction.create({
    bookingId: booking._id,
    physioId,
    type: 'online',
    totalAmount: physioEarning,
    commission,
    physioEarning,
    direction: 'credit',
    status: POSTED,
    meta: {
      leg: 'earning',
      gross,
    },
  });
  return { created: true };
}

/**
 * Offline: credit gross + debit commission (two posted lines).
 */
export async function postOfflinePair(booking) {
  const physioId = booking.physioId;
  if (!physioId) return { created: false, reason: 'no_physio' };
  const { gross, commission, physioEarning } = splitFromBooking(booking);
  if (!Number.isFinite(gross) || gross <= 0) return { created: false, reason: 'no_gross' };

  const dup = await Transaction.findOne({
    bookingId: booking._id,
    physioId,
    type: 'offline',
    status: POSTED,
    'meta.leg': 'gross',
  }).lean();
  if (dup) return { created: false, reason: 'duplicate' };

  await Transaction.create([
    {
      bookingId: booking._id,
      physioId,
      type: 'offline',
      totalAmount: gross,
      commission,
      physioEarning,
      direction: 'credit',
      status: POSTED,
      meta: { leg: 'gross' },
    },
    ...(commission > 0
      ? [
          {
            bookingId: booking._id,
            physioId,
            type: 'offline',
            totalAmount: commission,
            commission,
            physioEarning: 0,
            direction: 'debit',
            status: POSTED,
            meta: { leg: 'commission' },
          },
        ]
      : []),
  ]);
  return { created: true };
}

/**
 * Admin settlement: debit to platform; reduces commission due.
 */
export async function postSettlementDebit(physioId, amountRupees, opts = {}) {
  const amt = roundMoney2(Number(amountRupees));
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('amount must be a positive number');
    err.statusCode = 400;
    throw err;
  }
  const due = await computeCommissionDue(physioId);
  if (amt > due + 0.01) {
    const err = new Error('Amount exceeds commission due');
    err.statusCode = 400;
    throw err;
  }

  const idem = opts.idempotencyKey ? String(opts.idempotencyKey).slice(0, 64) : null;
  if (idem) {
    const exists = await Transaction.findOne({
      physioId,
      type: 'settlement',
      'meta.idempotencyKey': idem,
    }).lean();
    if (exists) return { created: false, duplicate: true, transactionId: exists._id };
  }

  await Transaction.create({
    bookingId: null,
    physioId,
    type: 'settlement',
    totalAmount: amt,
    commission: amt,
    physioEarning: 0,
    direction: 'debit',
    status: POSTED,
    meta: {
      note: typeof opts.note === 'string' ? opts.note.slice(0, 500) : '',
      ...(idem ? { idempotencyKey: idem } : {}),
    },
  });
  return { created: true };
}

/**
 * Reverse online earning (refund before release): debit mirror of credit.
 */
export async function postOnlineRefundDebit(booking) {
  const physioId = booking.physioId;
  if (!physioId) return { created: false };

  const orig = await Transaction.findOne({
    bookingId: booking._id,
    physioId,
    type: 'online',
    direction: 'credit',
    status: POSTED,
    'meta.leg': 'earning',
  }).lean();
  if (!orig) return { created: false, reason: 'no_original' };

  const dup = await Transaction.findOne({
    bookingId: booking._id,
    physioId,
    type: 'online',
    direction: 'debit',
    status: POSTED,
    'meta.leg': 'refund',
  }).lean();
  if (dup) return { created: false, reason: 'duplicate_refund' };

  const amt = roundMoney2(Number(orig.totalAmount));
  await Transaction.create({
    bookingId: booking._id,
    physioId,
    type: 'online',
    totalAmount: amt,
    commission: roundMoney2(Number(orig.commission || 0)),
    physioEarning: 0,
    direction: 'debit',
    status: POSTED,
    meta: { leg: 'refund', reason: 'refund', reverses: orig._id },
  });

  await Transaction.findByIdAndUpdate(orig._id, { status: 'reversed' });
  return { created: true };
}

/**
 * Cancel offline pair (e.g. booking voided): mark lines cancelled or reverse.
 */
export async function cancelOfflineLedgerForBooking(bookingId) {
  if (!mongoose.isValidObjectId(String(bookingId))) return { n: 0 };
  const res = await Transaction.updateMany(
    {
      bookingId,
      type: 'offline',
      status: POSTED,
    },
    { $set: { status: 'cancelled' } }
  );
  return { n: res.modifiedCount ?? 0 };
}

export async function cancelOnlineLedgerForBooking(bookingId) {
  if (!mongoose.isValidObjectId(String(bookingId))) return { n: 0 };
  const res = await Transaction.updateMany(
    {
      bookingId,
      type: 'online',
      status: POSTED,
    },
    { $set: { status: 'cancelled' } }
  );
  return { n: res.modifiedCount ?? 0 };
}

/** Mark all posted booking lines cancelled (e.g. booking voided before payout). */
export async function cancelAllLedgerForBooking(bookingId) {
  const [a, b] = await Promise.all([
    cancelOfflineLedgerForBooking(bookingId),
    cancelOnlineLedgerForBooking(bookingId),
  ]);
  return { offline: a.n, online: b.n };
}
