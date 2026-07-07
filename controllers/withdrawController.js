import mongoose from 'mongoose';
import WithdrawRequest from '../models/WithdrawRequest.js';
import Transaction from '../models/Transaction.js';
import { getComputedWallet, computeManagerCommissionBalance } from '../utils/ledgerBalance.js';
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

/** Care-manager mirror of getPendingWithdraw (manager auth chain sets req.user). */
export async function getManagerPendingWithdraw(req, res, next) {
  try {
    const managerId = req.user?.id;
    const pending = await WithdrawRequest.findOne({ managerId, status: 'pending' }).lean();
    return res.json({ pending });
  } catch (err) {
    next(err);
  }
}

/** Care-manager mirror of createWithdrawRequest — draws on settled commission. */
export async function createManagerWithdrawRequest(req, res, next) {
  try {
    const managerId = req.user?.id;
    const amount = parseAmount(req.body);
    if (amount == null) {
      return res.status(400).json({ message: 'Valid amount (INR) is required' });
    }
    if (amount < 1) {
      return res.status(400).json({ message: 'Minimum withdrawal is ₹1' });
    }

    const existing = await WithdrawRequest.findOne({ managerId, status: 'pending' }).lean();
    if (existing) {
      return res.status(400).json({ message: 'You already have a pending withdrawal request' });
    }

    const balance = await computeManagerCommissionBalance(managerId);
    if (amount > balance.availableBalance + 1e-6) {
      return res.status(400).json({
        message: `Amount exceeds withdrawable commission (${formatInr(balance.availableBalance)}). Commission becomes withdrawable after admin settles your cash hand-off.`,
      });
    }

    const doc = await WithdrawRequest.create({
      managerId,
      amount,
      status: 'pending',
      requestedAt: new Date(),
    });

    return res.status(201).json(doc.toObject());
  } catch (err) {
    next(err);
  }
}

export async function listWithdrawRequests(req, res, next) {
  try {
    const payee = String(req.query?.payee || '').trim();
    const filter = {};
    if (payee === 'manager') filter.managerId = { $ne: null };
    else if (payee === 'physio') filter.physioId = { $ne: null };

    const list = await WithdrawRequest.find(filter)
      .populate('physioId', 'name phone specialization')
      .populate('managerId', 'name phone')
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
    const payoutReference = String(req.body?.payoutReference || '').trim().slice(0, 120);

    const reqDoc = await WithdrawRequest.findById(id).lean();
    if (!reqDoc) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (reqDoc.status !== 'pending') {
      return res.status(400).json({ message: 'Request already processed' });
    }

    const isManager = Boolean(reqDoc.managerId);

    if (status === 'rejected') {
      const updated = await WithdrawRequest.findByIdAndUpdate(
        id,
        { $set: { status: 'rejected', processedAt: new Date(), rejectReason: note } },
        { new: true }
      )
        .populate('physioId', 'name phone')
        .populate('managerId', 'name phone')
        .lean();
      return res.json(updated);
    }

    if (isManager) {
      const balance = await computeManagerCommissionBalance(reqDoc.managerId);
      if (reqDoc.amount > balance.availableBalance + 1e-6) {
        return res.status(400).json({
          message: `Insufficient settled commission to approve (${formatInr(balance.availableBalance)} available)`,
        });
      }
    } else {
      const wallet = await getComputedWallet(reqDoc.physioId);
      if (reqDoc.amount > wallet.availableBalance + 1e-6) {
        return res.status(400).json({
          message: `Insufficient net withdrawable balance to approve (${formatInr(wallet.availableBalance)} available after commission due)`,
        });
      }
    }

    const claimed = await WithdrawRequest.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'approved', processedAt: new Date(), payoutReference } },
      { new: true }
    ).lean();

    if (!claimed) {
      return res.status(400).json({ message: 'Request is no longer pending' });
    }

    try {
      await Transaction.create(
        isManager
          ? {
              userId: reqDoc.managerId,
              physioId: null,
              bookingId: null,
              type: 'manager_withdrawal',
              direction: 'debit',
              totalAmount: reqDoc.amount,
              commission: 0,
              physioEarning: 0,
              status: 'posted',
              meta: {
                withdrawRequestId: String(reqDoc._id),
                note: note || 'Manager commission payout',
                payoutReference,
              },
            }
          : {
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
                payoutReference,
              },
            }
      );
    } catch (txErr) {
      await WithdrawRequest.findByIdAndUpdate(id, {
        $set: { status: 'pending', processedAt: null, payoutReference: '' },
      });
      throw txErr;
    }

    const out = await WithdrawRequest.findById(id)
      .populate('physioId', 'name phone')
      .populate('managerId', 'name phone')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}
