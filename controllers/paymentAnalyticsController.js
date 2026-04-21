import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Transaction from '../models/Transaction.js';
import WithdrawRequest from '../models/WithdrawRequest.js';
import { roundMoney2, settlePhysioCommissionDue } from '../utils/marketplacePayment.js';
import {
  computeGlobalPendingCommissionDue,
  listAllPhysioWalletsSummary,
  getComputedWallet,
} from '../utils/ledgerBalance.js';

/**
 * Admin finance summary tiles: gross revenue, platform commission earned,
 * pending commission dues, and pending payout requests.
 */
export async function getPaymentSummary(_req, res, next) {
  try {
    const [paid, pendingSettlements, pendingPayouts] = await Promise.all([
      Booking.find({ 'payment.status': { $in: ['paid', 'verified'] } }).select('payment').lean(),
      computeGlobalPendingCommissionDue(),
      WithdrawRequest.aggregate([
        { $match: { status: 'pending' } },
        { $group: { _id: null, sum: { $sum: '$amount' }, n: { $sum: 1 } } },
      ]),
    ]);

    let totalRevenue = 0;
    let totalCommission = 0;
    for (const b of paid) {
      const a = b.payment?.amount;
      const c = b.payment?.commission;
      if (Number.isFinite(Number(a))) totalRevenue += Number(a);
      if (Number.isFinite(Number(c))) totalCommission += Number(c);
    }

    const payoutsAmount = Number(pendingPayouts?.[0]?.sum || 0);
    const payoutsCount = Number(pendingPayouts?.[0]?.n || 0);

    return res.json({
      totalRevenue: roundMoney2(totalRevenue),
      totalCommission: roundMoney2(totalCommission),
      pendingSettlements: roundMoney2(pendingSettlements),
      pendingPayoutsAmount: roundMoney2(payoutsAmount),
      pendingPayoutsCount: payoutsCount,
      recordedPaymentsCount: paid.length,
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
    const pendingReqs = await WithdrawRequest.find({ status: 'pending' })
      .sort({ requestedAt: 1 })
      .lean();
    const pendingByPhysio = new Map(pendingReqs.map((r) => [String(r.physioId), r]));

    let rows = wallets.map((w) => {
      const pending = pendingByPhysio.get(String(w._id)) || null;
      return {
        ...w,
        pendingWithdrawal: pending
          ? {
              _id: pending._id,
              amount: pending.amount,
              requestedAt: pending.requestedAt,
              note: pending.note || '',
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
      recentTransactions: recentTx,
      settlementHistory,
      withdrawals,
      pendingWithdrawal: pending || null,
    });
  } catch (err) {
    next(err);
  }
}
