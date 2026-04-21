import mongoose from 'mongoose';
import WithdrawRequest from '../models/WithdrawRequest.js';
import Transaction from '../models/Transaction.js';
import { getComputedWallet } from '../utils/ledgerBalance.js';
import { roundMoney2 } from '../utils/marketplacePayment.js';

function parseAmount(body) {
  const raw = body?.amount ?? body?.amountRupees;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return roundMoney2(n);
}

export async function getPendingWithdraw(req, res, next) {
  try {
    const physioId = req.physio.id;
    const pending = await WithdrawRequest.findOne({ physioId, status: 'pending' }).lean();
    return res.json({ pending });
  } catch (err) {
    next(err);
  }
}

export async function createWithdrawRequest(req, res, next) {
  try {
    const physioId = req.physio.id;
    const amount = parseAmount(req.body);
    if (amount == null) {
      return res.status(400).json({ message: 'Valid amount (INR) is required' });
    }
    if (amount < 1) {
      return res.status(400).json({ message: 'Minimum withdrawal is ₹1' });
    }

    const existing = await WithdrawRequest.findOne({ physioId, status: 'pending' }).lean();
    if (existing) {
      return res.status(400).json({ message: 'You already have a pending withdrawal request' });
    }

    const wallet = await getComputedWallet(physioId);
    if (amount > wallet.availableBalance + 1e-6) {
      const hint =
        wallet.commissionDue > 0.01
          ? ` Net withdrawable is online balance (${formatInr(wallet.onlineAvailableBalance)}) minus commission due (${formatInr(wallet.commissionDue)}).`
          : '';
      return res.status(400).json({
        message: `Amount exceeds withdrawable balance (${formatInr(wallet.availableBalance)}).${hint}`,
      });
    }

    const doc = await WithdrawRequest.create({
      physioId,
      amount,
      status: 'pending',
      requestedAt: new Date(),
    });

    return res.status(201).json(doc.toObject());
  } catch (err) {
    next(err);
  }
}

function formatInr(n) {
  return `₹${roundMoney2(Number(n) || 0)}`;
}

export async function listWithdrawRequests(_req, res, next) {
  try {
    const list = await WithdrawRequest.find()
      .populate('physioId', 'name phone specialization')
      .sort({ requestedAt: -1 })
      .lean()
      .limit(200);

    return res.json(list);
  } catch (err) {
    next(err);
  }
}

export async function updateWithdrawStatus(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid request id' });
    }

    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'status must be approved or rejected' });
    }
    const note = String(req.body?.note || req.body?.reason || '').trim().slice(0, 500);

    const reqDoc = await WithdrawRequest.findById(id).lean();
    if (!reqDoc) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (reqDoc.status !== 'pending') {
      return res.status(400).json({ message: 'Request already processed' });
    }

    if (status === 'rejected') {
      const updated = await WithdrawRequest.findByIdAndUpdate(
        id,
        { $set: { status: 'rejected', processedAt: new Date() } },
        { new: true }
      )
        .populate('physioId', 'name phone')
        .lean();
      return res.json(updated);
    }

    const wallet = await getComputedWallet(reqDoc.physioId);
    if (reqDoc.amount > wallet.availableBalance + 1e-6) {
      return res.status(400).json({
        message: `Insufficient net withdrawable balance to approve (${formatInr(wallet.availableBalance)} available after commission due)`,
      });
    }

    const claimed = await WithdrawRequest.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'approved', processedAt: new Date() } },
      { new: true }
    ).lean();

    if (!claimed) {
      return res.status(400).json({ message: 'Request is no longer pending' });
    }

    try {
      await Transaction.create({
        physioId: reqDoc.physioId,
        bookingId: null,
        type: 'withdrawal',
        direction: 'debit',
        totalAmount: reqDoc.amount,
        commission: 0,
        physioEarning: 0,
        status: 'posted',
        meta: {
          withdrawRequestId: String(reqDoc._id),
          note: note || 'Withdrawal payout',
        },
      });
    } catch (txErr) {
      await WithdrawRequest.findByIdAndUpdate(id, {
        $set: { status: 'pending', processedAt: null },
      });
      throw txErr;
    }

    const out = await WithdrawRequest.findById(id).populate('physioId', 'name phone').lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}
