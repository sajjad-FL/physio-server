import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import Physiotherapist from '../models/Physiotherapist.js';

const POSTED = 'posted';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Net position: Σ(credit totalAmount) − Σ(debit totalAmount) for posted rows.
 */
export async function computeNetBalance(physioId) {
  const oid = new mongoose.Types.ObjectId(physioId);
  const rows = await Transaction.aggregate([
    { $match: { physioId: oid, status: POSTED } },
    {
      $group: {
        _id: '$direction',
        sum: { $sum: '$totalAmount' },
      },
    },
  ]);
  let credits = 0;
  let debits = 0;
  for (const r of rows) {
    if (r._id === 'credit') credits = r.sum;
    if (r._id === 'debit') debits = r.sum;
  }
  return roundMoney2(credits - debits);
}

/**
 * Commission owed to platform: offline commission debits minus settlement debits.
 */
export async function computeCommissionDue(physioId) {
  const oid = new mongoose.Types.ObjectId(physioId);
  const rows = await Transaction.aggregate([
    {
      $match: {
        physioId: oid,
        status: POSTED,
        $or: [
          { type: 'offline', direction: 'debit', 'meta.leg': 'commission' },
          { type: 'settlement', direction: 'debit' },
        ],
      },
    },
    {
      $group: {
        _id: { type: '$type', direction: '$direction' },
        sum: { $sum: '$totalAmount' },
      },
    },
  ]);
  let offlineCommission = 0;
  let settlements = 0;
  for (const r of rows) {
    const t = r._id?.type;
    if (t === 'offline') offlineCommission = r.sum;
    if (t === 'settlement') settlements = r.sum;
  }
  return roundMoney2(Math.max(0, offlineCommission - settlements));
}

/** Lifetime physio earnings recorded on credit legs (for dashboards). */
export async function computeTotalEarnedCredits(physioId) {
  const oid = new mongoose.Types.ObjectId(physioId);
  const [row] = await Transaction.aggregate([
    { $match: { physioId: oid, status: POSTED, direction: 'credit' } },
    { $group: { _id: null, sum: { $sum: '$physioEarning' } } },
  ]);
  return roundMoney2(row?.sum ?? 0);
}

export async function computeGlobalPendingCommissionDue() {
  const [offlineRows, setRows] = await Promise.all([
    Transaction.aggregate([
      {
        $match: {
          status: POSTED,
          type: 'offline',
          direction: 'debit',
          'meta.leg': 'commission',
        },
      },
      { $group: { _id: '$physioId', sum: { $sum: '$totalAmount' } } },
    ]),
    Transaction.aggregate([
      { $match: { status: POSTED, type: 'settlement', direction: 'debit' } },
      { $group: { _id: '$physioId', sum: { $sum: '$totalAmount' } } },
    ]),
  ]);
  const map = new Map();
  for (const r of offlineRows) {
    map.set(String(r._id), (map.get(String(r._id)) || 0) + r.sum);
  }
  for (const r of setRows) {
    const k = String(r._id);
    map.set(k, (map.get(k) || 0) - r.sum);
  }
  let total = 0;
  for (const v of map.values()) total += Math.max(0, v);
  return roundMoney2(total);
}

/**
 * Batch summary for admin table (no stored wallet).
 */
export async function listAllPhysioWalletsSummary() {
  const physios = await Physiotherapist.find({}).select('name phone specialization').sort({ name: 1 }).lean();
  if (physios.length === 0) return [];

  const ids = physios.map((p) => p._id);

  const [netRows, offlineRows, setRows, earnedRows] = await Promise.all([
    Transaction.aggregate([
      { $match: { physioId: { $in: ids }, status: POSTED } },
      {
        $project: {
          physioId: 1,
          signed: {
            $cond: [{ $eq: ['$direction', 'credit'] }, '$totalAmount', { $multiply: ['$totalAmount', -1] }],
          },
        },
      },
      { $group: { _id: '$physioId', net: { $sum: '$signed' } } },
    ]),
    Transaction.aggregate([
      {
        $match: {
          physioId: { $in: ids },
          status: POSTED,
          type: 'offline',
          direction: 'debit',
          'meta.leg': 'commission',
        },
      },
      { $group: { _id: '$physioId', sum: { $sum: '$totalAmount' } } },
    ]),
    Transaction.aggregate([
      { $match: { physioId: { $in: ids }, status: POSTED, type: 'settlement', direction: 'debit' } },
      { $group: { _id: '$physioId', sum: { $sum: '$totalAmount' } } },
    ]),
    Transaction.aggregate([
      { $match: { physioId: { $in: ids }, status: POSTED, direction: 'credit' } },
      { $group: { _id: '$physioId', sum: { $sum: '$physioEarning' } } },
    ]),
  ]);

  const netMap = new Map(netRows.map((r) => [String(r._id), roundMoney2(r.net)]));
  const ocMap = new Map(offlineRows.map((r) => [String(r._id), r.sum]));
  const stMap = new Map(setRows.map((r) => [String(r._id), r.sum]));
  const teMap = new Map(earnedRows.map((r) => [String(r._id), roundMoney2(r.sum ?? 0)]));

  return physios.map((p) => {
    const id = String(p._id);
    const offlineC = ocMap.get(id) || 0;
    const st = stMap.get(id) || 0;
    const commissionDue = roundMoney2(Math.max(0, offlineC - st));
    return {
      _id: p._id,
      name: p.name,
      phone: p.phone,
      specialization: p.specialization,
      wallet: {
        totalEarned: teMap.get(id) ?? 0,
        commissionDue,
        availableBalance: netMap.get(id) ?? 0,
      },
    };
  });
}

/** Per-physio wallet-shaped object for API compatibility (no DB wallet field). */
export async function getComputedWallet(physioId) {
  const [netBalance, commissionDue, totalEarnedFromCredits] = await Promise.all([
    computeNetBalance(physioId),
    computeCommissionDue(physioId),
    computeTotalEarnedCredits(physioId),
  ]);
  return {
    totalEarned: totalEarnedFromCredits,
    commissionDue,
    availableBalance: netBalance,
  };
}
