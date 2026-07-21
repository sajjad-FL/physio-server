import mongoose from 'mongoose';
import WithdrawRequest from '../models/WithdrawRequest.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import {
  getComputedWallet,
  computeManagerCommissionBalance,
  computeClinicCommissionBalance,
} from '../utils/ledgerBalance.js';
import { roundMoney2 } from '../utils/marketplacePayment.js';
import { resolveWithdrawRequestPayout } from '../utils/payoutUpi.js';
import { readPagination, paginationMeta } from '../utils/pagination.js';

const PAYEE_PROFILE_FIELDS = 'name phone payoutUpiId payoutDisplayName';
const PHYSIO_PROFILE_FIELDS = 'name phone specialization payoutUpiId payoutDisplayName';

async function enrichWithdrawRow(row, { backfillPending = false } = {}) {
  const resolved = resolveWithdrawRequestPayout(row);
  if (
    backfillPending &&
    row.status === 'pending' &&
    !String(row.payoutUpiId || '').trim() &&
    resolved.payoutUpiId
  ) {
    await WithdrawRequest.findByIdAndUpdate(row._id, {
      $set: {
        payoutUpiId: resolved.payoutUpiId,
        payoutDisplayName: resolved.payoutDisplayName,
      },
    });
  }
  return {
    ...row,
    payoutUpiId: resolved.payoutUpiId,
    payoutDisplayName: resolved.payoutDisplayName,
  };
}

async function resolvePayoutForRequest(reqDoc) {
  const resolved = resolveWithdrawRequestPayout(reqDoc);
  if (resolved.payoutUpiId) return resolved;

  if (reqDoc.managerId) {
    const manager = await User.findById(reqDoc.managerId)
      .select('payoutUpiId payoutDisplayName name')
      .lean();
    return resolveWithdrawRequestPayout({ managerId: manager });
  }
  if (reqDoc.physioId) {
    const physio = await Physiotherapist.findById(reqDoc.physioId)
      .select('payoutUpiId payoutDisplayName name')
      .lean();
    return resolveWithdrawRequestPayout({ physioId: physio });
  }
  return { payoutUpiId: '', payoutDisplayName: '' };
}

function parseAmount(body) {
  const raw = body?.amount ?? body?.amountRupees;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return roundMoney2(n);
}

function formatInr(n) {
  return `₹${roundMoney2(Number(n) || 0)}`;
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

    const physio = await Physiotherapist.findById(physioId)
      .select('payoutUpiId payoutDisplayName name')
      .lean();
    const payoutUpiId = String(physio?.payoutUpiId || '').trim();
    if (!payoutUpiId) {
      return res.status(400).json({
        message: 'Add your UPI ID on the Wallet page before requesting a withdrawal',
      });
    }
    const payoutDisplayName =
      String(physio?.payoutDisplayName || '').trim() || String(physio?.name || '').trim();

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
      payoutUpiId,
      payoutDisplayName,
    });

    return res.status(201).json(doc.toObject());
  } catch (err) {
    next(err);
  }
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

    const manager = await User.findById(managerId).select('payoutUpiId payoutDisplayName name').lean();
    const payoutUpiId = String(manager?.payoutUpiId || '').trim();
    if (!payoutUpiId) {
      return res.status(400).json({
        message: 'Add your UPI ID on the Finance page before requesting a withdrawal',
      });
    }
    const payoutDisplayName =
      String(manager?.payoutDisplayName || '').trim() || String(manager?.name || '').trim();

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
      payoutUpiId,
      payoutDisplayName,
    });

    return res.status(201).json(doc.toObject());
  } catch (err) {
    next(err);
  }
}

export async function listWithdrawRequests(req, res, next) {
  try {
    const payee = String(req.query?.payee || '').trim();
    const status = String(req.query?.status || '').trim();
    const search = String(req.query?.search || '').trim();
    const dateFrom = String(req.query?.dateFrom || '').trim();
    const dateTo = String(req.query?.dateTo || '').trim();
    const amountMin = Number(req.query?.amountMin);
    const amountMax = Number(req.query?.amountMax);
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 10, maxLimit: 50 });

    const filter = {};
    if (payee === 'manager') filter.managerId = { $ne: null };
    else if (payee === 'physio') filter.physioId = { $ne: null };
    if (['pending', 'approved', 'rejected'].includes(status)) filter.status = status;

    if (dateFrom || dateTo) {
      filter.requestedAt = {};
      if (dateFrom) filter.requestedAt.$gte = new Date(`${dateFrom}T00:00:00`);
      if (dateTo) filter.requestedAt.$lte = new Date(`${dateTo}T23:59:59.999`);
    }

    if (Number.isFinite(amountMin) && req.query?.amountMin !== '') {
      filter.amount = { ...(filter.amount || {}), $gte: amountMin };
    }
    if (Number.isFinite(amountMax) && req.query?.amountMax !== '') {
      filter.amount = { ...(filter.amount || {}), $lte: amountMax };
    }

    let list = await WithdrawRequest.find(filter)
      .populate('physioId', PHYSIO_PROFILE_FIELDS)
      .populate('managerId', PAYEE_PROFILE_FIELDS)
      .sort({ requestedAt: -1 })
      .lean();

    if (search) {
      const q = search.toLowerCase();
      list = list.filter((row) => {
        const name = String(row.managerId?.name || row.physioId?.name || '').toLowerCase();
        const phone = String(row.managerId?.phone || row.physioId?.phone || '');
        const upi = String(row.payoutUpiId || '').toLowerCase();
        return name.includes(q) || phone.includes(q) || upi.includes(q);
      });
    }

    const total = list.length;
    const pageRows = list.slice(skip, skip + limit);
    const data = await Promise.all(pageRows.map((row) => enrichWithdrawRow(row, { backfillPending: true })));
    return res.json({ data, ...paginationMeta({ page, limit, total }) });
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
    const isClinic = Boolean(reqDoc.clinicStaffUserId);

    if (status === 'rejected') {
      const updated = await WithdrawRequest.findByIdAndUpdate(
        id,
        { $set: { status: 'rejected', processedAt: new Date(), rejectReason: note } },
        { new: true }
      )
        .populate('physioId', 'name phone')
        .populate('managerId', 'name phone')
        .populate('clinicStaffUserId', 'name phone')
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
    } else if (isClinic) {
      const balance = await computeClinicCommissionBalance(reqDoc.clinicStaffUserId);
      if (reqDoc.amount > balance.availableBalance + 1e-6) {
        return res.status(400).json({
          message: `Insufficient settled clinic commission to approve (${formatInr(balance.availableBalance)} available)`,
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

    const payout = await resolvePayoutForRequest(reqDoc);
    const approveUpdate = {
      status: 'approved',
      processedAt: new Date(),
      payoutReference,
    };
    if (payout.payoutUpiId && !String(reqDoc.payoutUpiId || '').trim()) {
      approveUpdate.payoutUpiId = payout.payoutUpiId;
      approveUpdate.payoutDisplayName = payout.payoutDisplayName;
    }

    const claimed = await WithdrawRequest.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: approveUpdate },
      { new: true }
    ).lean();

    if (!claimed) {
      return res.status(400).json({ message: 'Request is no longer pending' });
    }

    const payoutUpiId = String(claimed.payoutUpiId || payout.payoutUpiId || '').trim();

    try {
      const txDoc = isManager
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
              payoutUpiId,
            },
          }
        : isClinic
          ? {
              userId: reqDoc.clinicStaffUserId,
              physioId: null,
              bookingId: null,
              type: 'clinic_withdrawal',
              direction: 'debit',
              totalAmount: reqDoc.amount,
              commission: 0,
              physioEarning: 0,
              status: 'posted',
              meta: {
                withdrawRequestId: String(reqDoc._id),
                note: note || 'Clinic commission payout',
                payoutReference,
                payoutUpiId,
                clinicId: reqDoc.clinicId ? String(reqDoc.clinicId) : undefined,
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
                payoutUpiId,
              },
            };
      await Transaction.create(txDoc);
    } catch (txErr) {
      await WithdrawRequest.findByIdAndUpdate(id, {
        $set: { status: 'pending', processedAt: null, payoutReference: '' },
      });
      throw txErr;
    }

    const out = await WithdrawRequest.findById(id)
      .populate('physioId', 'name phone')
      .populate('managerId', 'name phone')
      .populate('clinicStaffUserId', 'name phone')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}
