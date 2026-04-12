import mongoose from 'mongoose';
import Physiotherapist from '../models/Physiotherapist.js';
import Transaction from '../models/Transaction.js';
import { getComputedWallet } from '../utils/ledgerBalance.js';
import { roundMoney2 } from '../utils/marketplacePayment.js';

const POSTED = 'posted';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query?.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export async function getWalletDashboard(req, res, next) {
  try {
    const physioId = req.physio.id;
    const oid = new mongoose.Types.ObjectId(physioId);

    const physio = await Physiotherapist.findById(physioId).select('name').lean();
    if (!physio) return res.status(404).json({ message: 'Not found' });

    const wallet = await getComputedWallet(physioId);

    const [onlineAgg, offlineGrossAgg, offlineCommAgg, settlementAgg] = await Promise.all([
      Transaction.aggregate([
        {
          $match: {
            physioId: oid,
            status: POSTED,
            type: 'online',
            direction: 'credit',
            'meta.leg': 'earning',
          },
        },
        { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: '$totalAmount' } } },
      ]),
      Transaction.aggregate([
        {
          $match: {
            physioId: oid,
            status: POSTED,
            type: 'offline',
            direction: 'credit',
            'meta.leg': 'gross',
          },
        },
        { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: '$totalAmount' }, physioShare: { $sum: '$physioEarning' } } },
      ]),
      Transaction.aggregate([
        {
          $match: {
            physioId: oid,
            status: POSTED,
            type: 'offline',
            direction: 'debit',
            'meta.leg': 'commission',
          },
        },
        { $group: { _id: null, commissionAccrued: { $sum: '$totalAmount' } } },
      ]),
      Transaction.aggregate([
        { $match: { physioId: oid, status: POSTED, type: 'settlement', direction: 'debit' } },
        { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: '$totalAmount' } } },
      ]),
    ]);

    const o = onlineAgg[0] || {};
    const fg = offlineGrossAgg[0] || {};
    const fc = offlineCommAgg[0] || {};
    const st = settlementAgg[0] || {};

    const breakdown = {
      online_payment: {
        count: o.count || 0,
        volume: roundMoney2(o.volume || 0),
      },
      offline_payment: {
        count: fg.count || 0,
        volume: roundMoney2(fg.volume || 0),
        commissionAccrued: roundMoney2(fc.commissionAccrued || 0),
        physioShare: roundMoney2(fg.physioShare || 0),
      },
      settlement: {
        count: st.count || 0,
        volume: roundMoney2(st.volume || 0),
      },
    };

    return res.json({
      name: physio.name,
      wallet,
      breakdown,
    });
  } catch (err) {
    next(err);
  }
}

function buildNetAvailableSummaryRow(wallet) {
  const online = Number(wallet.onlineAvailableBalance) || 0;
  const due = Number(wallet.commissionDue) || 0;
  const net = Number(wallet.availableBalance) || 0;
  if (due < 1e-6) return null;
  return {
    _id: '__synthetic_net_available',
    isSynthetic: true,
    syntheticKind: 'net_available',
    createdAt: new Date(),
    type: 'online',
    direction: 'credit',
    totalAmount: net,
    commission: 0,
    physioEarning: net,
    status: 'posted',
    meta: {
      onlineAvailableBalance: online,
      commissionDue: due,
      netWithdrawable: net,
    },
    bookingId: null,
  };
}

export async function listWalletTransactions(req, res, next) {
  try {
    const physioId = req.physio.id;
    const { page, limit, skip } = readPagination(req.query);

    const [list, total, wallet] = await Promise.all([
      Transaction.find({ physioId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('bookingId', 'date timeSlot serviceType payment')
        .lean(),
      Transaction.countDocuments({ physioId }),
      page === 1 ? getComputedWallet(physioId) : Promise.resolve(null),
    ]);

    let data = list;
    if (page === 1 && wallet) {
      const summary = buildNetAvailableSummaryRow(wallet);
      if (summary) data = [summary, ...list];
    }

    return res.json({
      data,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}
