import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Payment from '../models/Payment.js';
import Transaction from '../models/Transaction.js';
import WithdrawRequest from '../models/WithdrawRequest.js';
import ManagerLedgerEntry from '../models/ManagerLedgerEntry.js';
import { roundMoney2, settlePhysioCommissionDue } from '../utils/marketplacePayment.js';
import {
  computeGlobalPendingCommissionDue,
  listAllPhysioWalletsSummary,
  getComputedWallet,
} from '../utils/ledgerBalance.js';
import { resolveWithdrawRequestPayout } from '../utils/payoutUpi.js';
import { computeEntryShares } from '../services/managerSettlement.js';

/**
 * Platform fee actually realized:
 * - manager cash after settlement batch distribute (distribution.platformShare)
 * - manager PhonePe QR after admin verify (amount − physio − manager)
 * - online patient payments (commission on earning credits)
 * - physio remitted offline commission (settlement debits)
 */
async function sumPlatformFeeCollected() {
  const [settledCash, onlineCommission, remitted, phonePePayments] = await Promise.all([
    ManagerLedgerEntry.aggregate([
      {
        $match: {
          direction: 'credit',
          'distribution.distributedAt': { $exists: true, $ne: null },
        },
      },
      { $group: { _id: null, sum: { $sum: '$distribution.platformShare' } } },
    ]),
    Transaction.aggregate([
      {
        $match: {
          status: 'posted',
          type: 'online',
          direction: 'credit',
          'meta.leg': 'earning',
          'meta.source': { $nin: ['manager_settlement', 'manager_phonepe_qr'] },
        },
      },
      { $group: { _id: null, sum: { $sum: '$commission' } } },
    ]),
    Transaction.aggregate([
      {
        $match: {
          status: 'posted',
          type: 'settlement',
          direction: 'debit',
        },
      },
      { $group: { _id: null, sum: { $sum: '$totalAmount' } } },
    ]),
    Payment.find({
      status: 'verified',
      'meta.collectionChannel': 'phonepe_qr',
    })
      .select('amount meta bookingId')
      .lean(),
  ]);

  let phonePePlatform = 0;
  if (phonePePayments.length > 0) {
    const bookingIds = [
      ...new Set(
        phonePePayments
          .map((p) => p.bookingId)
          .filter((id) => id && mongoose.isValidObjectId(String(id)))
          .map((id) => String(id)),
      ),
    ];
    const bookings = bookingIds.length
      ? await Booking.find({ _id: { $in: bookingIds } }).lean()
      : [];
    const byId = new Map(bookings.map((b) => [String(b._id), b]));
    for (const p of phonePePayments) {
      const booking = byId.get(String(p.bookingId));
      const snap = Number(p.meta?.managerCommissionAmount);
      const shares = computeEntryShares(
        {
          amount: p.amount,
          managerCommissionAmount: Number.isFinite(snap) ? snap : null,
        },
        booking,
      );
      phonePePlatform += Number(shares.platformShare) || 0;
    }
  }

  return roundMoney2(
    Number(settledCash?.[0]?.sum || 0) +
      Number(onlineCommission?.[0]?.sum || 0) +
      Number(remitted?.[0]?.sum || 0) +
      phonePePlatform,
  );
}

function shapeTransactionBookingRef(booking) {
  if (!booking || typeof booking !== 'object') return null;
  const patientName =
    booking.userId && typeof booking.userId === 'object' ? booking.userId?.name : null;
  return {
    id: booking._id,
    issue: booking.issue,
    patientName,
    date: booking.date,
    timeSlot: booking.timeSlot,
    bookingCode: booking.bookingCode || null,
    bookingSeq: booking.bookingSeq ?? null,
  };
}

function shapeFinanceTransaction(tx) {
  const booking = tx.bookingId;
  return {
    ...tx,
    bookingRef: shapeTransactionBookingRef(booking),
  };
}

/**
 * Admin finance summary tiles: gross revenue from verified installments,
 * realized platform fee, pending physio dues, and payouts.
 */
export async function getPaymentSummary(_req, res, next) {
  try {
    const [verifiedPayments, totalCommission, pendingSettlements, pendingPayouts, pendingVerification] =
      await Promise.all([
        Payment.aggregate([
          { $match: { status: 'verified' } },
          { $group: { _id: null, sum: { $sum: '$amount' }, n: { $sum: 1 } } },
        ]),
        sumPlatformFeeCollected(),
        computeGlobalPendingCommissionDue(),
        WithdrawRequest.aggregate([
          { $match: { status: 'pending' } },
          { $group: { _id: null, sum: { $sum: '$amount' }, n: { $sum: 1 } } },
        ]),
        Payment.countDocuments({ mode: 'offline', status: 'collected' }),
      ]);

    const totalRevenue = roundMoney2(Number(verifiedPayments?.[0]?.sum) || 0);
    const verifiedPaymentCount = Number(verifiedPayments?.[0]?.n) || 0;
    const payoutsAmount = Number(pendingPayouts?.[0]?.sum || 0);
    const payoutsCount = Number(pendingPayouts?.[0]?.n || 0);

    return res.json({
      totalRevenue,
      totalCommission,
      pendingSettlements: roundMoney2(pendingSettlements),
      pendingPayoutsAmount: roundMoney2(payoutsAmount),
      pendingPayoutsCount: payoutsCount,
      pendingVerification: Number(pendingVerification) || 0,
      recordedPaymentsCount: verifiedPaymentCount,
    });
  } catch (err) {
    next(err);
  }
}

/** Record that a physio remitted commission (cash/bank to platform). Lowers commissionDue. */
export async function postSettleCommission(req, res, next) {
  try {
    const { physioId, amount } = req.body || {};
    if (!physioId || !mongoose.isValidObjectId(String(physioId))) {
      return res.status(400).json({ message: 'valid physioId is required' });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }

    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    const idempotencyKey =
      typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.trim().slice(0, 64) : undefined;

    try {
      const updated = await settlePhysioCommissionDue(physioId, amt, { note, idempotencyKey });
      return res.json(updated);
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ message: e.message || 'Settlement failed' });
    }
  } catch (err) {
    next(err);
  }
}

/**
 * Unified physio finance table: one row per physio with wallet snapshot AND
 * the current pending withdrawal (if any). This replaces the old separate
 * Settlements + Withdrawals pages.
 */
export async function listPhysiosWalletTable(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 20));
    const search = String(req.query?.search || '').trim().toLowerCase();
    const filter = String(req.query?.filter || 'all');

    const wallets = await listAllPhysioWalletsSummary();
    const pendingReqs = await WithdrawRequest.find({ status: 'pending', physioId: { $ne: null } })
      .sort({ requestedAt: 1 })
      .lean();
    const pendingByPhysio = new Map(pendingReqs.map((r) => [String(r.physioId), r]));

    let rows = wallets.map((w) => {
      const pending = pendingByPhysio.get(String(w._id)) || null;
      const payout = pending
        ? resolveWithdrawRequestPayout({ ...pending, physioId: w })
        : { payoutUpiId: '', payoutDisplayName: '' };
      return {
        ...w,
        pendingWithdrawal: pending
          ? {
              _id: pending._id,
              amount: pending.amount,
              requestedAt: pending.requestedAt,
              note: pending.note || '',
              payoutUpiId: payout.payoutUpiId,
              payoutDisplayName: payout.payoutDisplayName,
              payoutReference: pending.payoutReference || '',
            }
          : null,
      };
    });

    if (search) {
      rows = rows.filter(
        (r) =>
          String(r.name || '').toLowerCase().includes(search) ||
          String(r.phone || '').toLowerCase().includes(search),
      );
    }

    if (filter === 'due') {
      rows = rows.filter((r) => Number(r.wallet?.commissionDue || 0) > 0.009);
    } else if (filter === 'payout') {
      rows = rows.filter((r) => r.pendingWithdrawal);
    } else if (filter === 'active') {
      rows = rows.filter(
        (r) =>
          Number(r.wallet?.commissionDue || 0) > 0.009 ||
          Number(r.wallet?.availableBalance || 0) > 0.009 ||
          r.pendingWithdrawal,
      );
    }

    // Actionable physios (due or pending payout) float to the top.
    rows.sort((a, b) => {
      const score = (r) =>
        (r.pendingWithdrawal ? 1000000 : 0) + Number(r.wallet?.commissionDue || 0);
      return score(b) - score(a);
    });

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const skip = (page - 1) * limit;
    const data = rows.slice(skip, skip + limit);

    return res.json({ data, total, page, totalPages });
  } catch (err) {
    next(err);
  }
}

/**
 * Per-physio finance drawer: wallet snapshot, recent ledger activity, past
 * settlements, and withdrawal history.
 */
export async function getPhysioFinanceDetail(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid physio id' });
    }

    const oid = new mongoose.Types.ObjectId(id);
    const [wallet, recentTx, settlementHistory, withdrawals, pending] = await Promise.all([
      getComputedWallet(id),
      Transaction.find({ physioId: oid, status: 'posted' })
        .sort({ createdAt: -1 })
        .limit(30)
        .populate({
          path: 'bookingId',
          select: 'issue date timeSlot userId bookingCode bookingSeq',
          populate: { path: 'userId', select: 'name phone' },
        })
        .lean(),
      Transaction.find({ physioId: oid, status: 'posted', type: 'settlement' })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      WithdrawRequest.find({ physioId: oid })
        .sort({ requestedAt: -1 })
        .limit(20)
        .lean(),
      WithdrawRequest.findOne({ physioId: oid, status: 'pending' }).lean(),
    ]);

    return res.json({
      wallet,
      recentTransactions: recentTx.map(shapeFinanceTransaction),
      settlementHistory,
      withdrawals,
      pendingWithdrawal: pending || null,
    });
  } catch (err) {
    next(err);
  }
}
