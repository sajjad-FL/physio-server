import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import Physiotherapist from '../models/Physiotherapist.js';

const POSTED = 'posted';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Withdrawable online earnings only:
 * online earning credits - online debits/refunds - withdrawal debits.
 */
export async function computeOnlineWithdrawable(physioId) {
  const oid = new mongoose.Types.ObjectId(physioId);
  const [rows] = await Transaction.aggregate([
    { $match: { physioId: oid, status: POSTED } },
    {
      $group: {
        _id: null,
        onlineCredits: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$type', 'online'] },
                  { $eq: ['$direction', 'credit'] },
                  { $eq: ['$meta.leg', 'earning'] },
                ],
              },
              '$totalAmount',
              0,
            ],
          },
        },
        onlineDebits: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $and: [{ $eq: ['$type', 'online'] }, { $eq: ['$direction', 'debit'] }] },
                  { $and: [{ $eq: ['$type', 'withdrawal'] }, { $eq: ['$direction', 'debit'] }] },
                ],
              },
              '$totalAmount',
              0,
            ],
          },
        },
      },
    },
  ]);
  const credits = Number(rows?.onlineCredits || 0);
  const debits = Number(rows?.onlineDebits || 0);
  return roundMoney2(Math.max(0, credits - debits));
}

/** Gross cash collected by physio from offline bookings. */
export async function computeOfflineCollected(physioId) {
  const oid = new mongoose.Types.ObjectId(physioId);
  const [row] = await Transaction.aggregate([
    {
      $match: {
        physioId: oid,
        status: POSTED,
        type: 'offline',
        direction: 'credit',
        'meta.leg': 'gross',
      },
    },
    { $group: { _id: null, sum: { $sum: '$totalAmount' } } },
  ]);
  return roundMoney2(row?.sum ?? 0);
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

  const [onlineRows, offlineGrossRows, offlineCommissionRows, onlineDebitRows, settlementRows] = await Promise.all([
    Transaction.aggregate([
      {
        $match: {
          physioId: { $in: ids },
          status: POSTED,
          type: 'online',
          direction: 'credit',
          'meta.leg': 'earning',
        },
      },
      { $group: { _id: '$physioId', sum: { $sum: '$totalAmount' } } },
    ]),
    Transaction.aggregate([
      {
        $match: {
          physioId: { $in: ids },
          status: POSTED,
          type: 'offline',
          direction: 'credit',
          'meta.leg': 'gross',
        },
      },
      { $group: { _id: '$physioId', sum: { $sum: '$totalAmount' } } },
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
      {
        $match: {
          physioId: { $in: ids },
          status: POSTED,
          $or: [
            { type: 'online', direction: 'debit' },
            { type: 'withdrawal', direction: 'debit' },
          ],
        },
      },
      { $group: { _id: '$physioId', sum: { $sum: '$totalAmount' } } },
    ]),
    Transaction.aggregate([
      { $match: { physioId: { $in: ids }, status: POSTED, type: 'settlement', direction: 'debit' } },
      { $group: { _id: '$physioId', sum: { $sum: '$totalAmount' } } },
    ]),
  ]);

  const onlineMap = new Map(onlineRows.map((r) => [String(r._id), roundMoney2(r.sum ?? 0)]));
  const offlineGrossMap = new Map(offlineGrossRows.map((r) => [String(r._id), roundMoney2(r.sum ?? 0)]));
  const offlineCommissionMap = new Map(offlineCommissionRows.map((r) => [String(r._id), roundMoney2(r.sum ?? 0)]));
  const onlineDebitMap = new Map(onlineDebitRows.map((r) => [String(r._id), roundMoney2(r.sum ?? 0)]));
  const settlementMap = new Map(settlementRows.map((r) => [String(r._id), roundMoney2(r.sum ?? 0)]));

  return physios.map((p) => {
    const id = String(p._id);
    const onlineGross = onlineMap.get(id) || 0;
    const onlineDebits = onlineDebitMap.get(id) || 0;
    const onlineEarning = roundMoney2(Math.max(0, onlineGross - onlineDebits));
    const offlineCollected = offlineGrossMap.get(id) || 0;
    const offlineCommission = offlineCommissionMap.get(id) || 0;
    const settlements = settlementMap.get(id) || 0;
    const commissionDue = roundMoney2(Math.max(0, offlineCommission - settlements));
    const netWithdrawable = roundMoney2(Math.max(0, onlineEarning - commissionDue));
    return {
      _id: p._id,
      name: p.name,
      phone: p.phone,
      specialization: p.specialization,
      wallet: {
        totalEarned: roundMoney2(onlineEarning + offlineCollected),
        onlineEarning,
        onlineAvailableBalance: onlineEarning,
        offlineCollected,
        commissionDue,
        availableBalance: netWithdrawable,
      },
    };
  });
}

/** Per-physio wallet-shaped object for API compatibility (no DB wallet field). */
export async function getComputedWallet(physioId) {
  const [onlineEarning, offlineCollected, commissionDue] = await Promise.all([
    computeOnlineWithdrawable(physioId),
    computeOfflineCollected(physioId),
    computeCommissionDue(physioId),
  ]);
  const onlineAvailableBalance = roundMoney2(onlineEarning);
  const cd = roundMoney2(commissionDue);
  const netWithdrawable = roundMoney2(Math.max(0, onlineAvailableBalance - cd));
  return {
    totalEarned: roundMoney2(onlineEarning + offlineCollected),
    onlineEarning: onlineAvailableBalance,
    onlineAvailableBalance,
    offlineCollected,
    commissionDue: cd,
    /** Amount the physio may withdraw (online pot minus offline commission owed). */
    availableBalance: netWithdrawable,
  };
}
