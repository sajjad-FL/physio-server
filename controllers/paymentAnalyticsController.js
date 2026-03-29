import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import { roundMoney2, settlePhysioCommissionDue } from '../utils/marketplacePayment.js';
import { computeGlobalPendingCommissionDue, listAllPhysioWalletsSummary } from '../utils/ledgerBalance.js';

/**
 * Admin dashboard: gross revenue and platform commission from recorded payments,
 * plus total commission owed by physios (offline cash model).
 */
export async function getPaymentSummary(req, res, next) {
  try {
    const paid = await Booking.find({
      'payment.status': { $in: ['paid', 'verified'] },
    })
      .select('payment')
      .lean();

    let totalRevenue = 0;
    let totalCommission = 0;
    for (const b of paid) {
      const a = b.payment?.amount;
      const c = b.payment?.commission;
      if (Number.isFinite(Number(a))) totalRevenue += Number(a);
      if (Number.isFinite(Number(c))) totalCommission += Number(c);
    }

    const pendingSettlements = await computeGlobalPendingCommissionDue();

    return res.json({
      totalRevenue: roundMoney2(totalRevenue),
      totalCommission: roundMoney2(totalCommission),
      pendingSettlements: roundMoney2(pendingSettlements),
      recordedPaymentsCount: paid.length,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Record that a physio remitted commission (cash/bank to platform). Lowers commissionDue.
 */
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

/** Table rows for settlement UI — balances computed from Transaction ledger. */
export async function listPhysiosWalletTable(req, res, next) {
  try {
    const data = await listAllPhysioWalletsSummary();
    return res.json({ data });
  } catch (err) {
    next(err);
  }
}
