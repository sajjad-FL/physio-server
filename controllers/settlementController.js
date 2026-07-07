import mongoose from 'mongoose';
import ManagerLedgerEntry from '../models/ManagerLedgerEntry.js';
import ManagerSettlementBatch from '../models/ManagerSettlementBatch.js';
import Payment from '../models/Payment.js';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import { recomputeBookingPaymentRollup } from '../utils/installmentRollup.js';
import { distributeSettlementBatch, previewDistribution } from '../services/managerSettlement.js';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const LEDGER_BOOKING_POPULATE = {
  path: 'bookingId',
  select: 'issue date timeSlot totalAmount userId',
  populate: { path: 'userId', select: 'name phone' },
};

function shapeBookingRef(booking) {
  if (!booking || typeof booking !== 'object') return null;
  const patientName =
    booking.userId && typeof booking.userId === 'object' ? booking.userId?.name : null;
  return {
    id: booking._id,
    issue: booking.issue,
    patientName,
    date: booking.date,
    timeSlot: booking.timeSlot,
  };
}

function shapeLedgerEntry(entry) {
  const booking = entry.bookingId;
  return {
    ...entry,
    bookingRef: shapeBookingRef(booking),
  };
}

async function shapeSettlementBatches(batches) {
  if (!batches?.length) return [];
  const populated = await ManagerSettlementBatch.find({ _id: { $in: batches.map((b) => b._id) } })
    .populate({
      path: 'ledgerEntryIds',
      populate: LEDGER_BOOKING_POPULATE,
    })
    .lean();
  const byId = new Map(populated.map((b) => [String(b._id), b]));
  return Promise.all(
    batches.map(async (batch) => {
      const full = byId.get(String(batch._id));
      const rawEntries = full?.ledgerEntryIds || [];
      const entries = rawEntries
        .filter((e) => e && typeof e === 'object')
        .map(shapeLedgerEntry);
      // Open batches: dry-run "what happens on settle". Settled: stored totals.
      const distributionPreview =
        batch.status === 'open' ? await previewDistribution(entries) : null;
      return {
        ...batch,
        entryCount: entries.length,
        entries,
        distributionPreview,
      };
    }),
  );
}

/** Total commission already credited to a manager (posted manager_commission rows). */
async function sumSettledCommission(managerId) {
  const rows = await Transaction.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(String(managerId)),
        type: 'manager_commission',
        direction: 'credit',
        status: 'posted',
      },
    },
    { $group: { _id: null, total: { $sum: '$totalAmount' } } },
  ]);
  return roundMoney2(rows[0]?.total || 0);
}

export async function getManagerLedgerAdmin(req, res, next) {
  try {
    const { managerId } = req.params;
    if (!mongoose.isValidObjectId(managerId)) {
      return res.status(400).json({ message: 'Invalid manager id' });
    }

    const manager = await User.findById(managerId).select('name phone role').lean();
    if (!manager || manager.role !== 'care_manager') {
      return res.status(404).json({ message: 'Care manager not found' });
    }

    const entries = await ManagerLedgerEntry.find({ managerId })
      .sort({ createdAt: -1 })
      .populate(LEDGER_BOOKING_POPULATE)
      .lean();

    const shapedEntries = entries.map(shapeLedgerEntry);

    const openTotal = shapedEntries
      .filter((e) => e.status === 'open' && e.direction === 'credit')
      .reduce((s, e) => s + Number(e.amount || 0), 0);

    // Commission owed to this manager: accrues on open/batched collections,
    // becomes "settled" (withdrawable) once the cash hand-off is settled.
    const pendingCommissionEntries = shapedEntries.filter(
      (e) => (e.status === 'open' || e.status === 'batched') && e.direction === 'credit',
    );
    const pendingPreview = await previewDistribution(pendingCommissionEntries);
    const settledCommission = await sumSettledCommission(managerId);

    const rawBatches = await ManagerSettlementBatch.find({ managerId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const batches = await shapeSettlementBatches(rawBatches);

    return res.json({
      manager,
      entries: shapedEntries,
      openTotal: roundMoney2(openTotal),
      pendingCommission: pendingPreview.managerTotal,
      settledCommission,
      batches,
    });
  } catch (err) {
    next(err);
  }
}

export async function createSettlementBatch(req, res, next) {
  try {
    const { managerId } = req.params;
    const { ledgerEntryIds, settledAmount, settlementMethod, notes } = req.body || {};

    if (!mongoose.isValidObjectId(managerId)) {
      return res.status(400).json({ message: 'Invalid manager id' });
    }
    if (!Array.isArray(ledgerEntryIds) || ledgerEntryIds.length === 0) {
      return res.status(400).json({ message: 'ledgerEntryIds is required' });
    }

    const ids = ledgerEntryIds.filter((id) => mongoose.isValidObjectId(id));
    const entries = await ManagerLedgerEntry.find({
      _id: { $in: ids },
      managerId,
      status: 'open',
      direction: 'credit',
    });

    if (entries.length !== ids.length) {
      return res.status(400).json({ message: 'Some ledger entries are invalid or already batched' });
    }

    const expectedAmount = roundMoney2(entries.reduce((s, e) => s + Number(e.amount || 0), 0));
    const settled = roundMoney2(Number(settledAmount ?? expectedAmount));
    if (!Number.isFinite(settled) || settled < 0) {
      return res.status(400).json({ message: 'settledAmount must be a non-negative number' });
    }

    const batch = await ManagerSettlementBatch.create({
      managerId,
      ledgerEntryIds: entries.map((e) => e._id),
      expectedAmount,
      settledAmount: settled,
      settlementMethod: String(settlementMethod || 'cash_handoff').trim(),
      notes: String(notes || '').trim().slice(0, 2000),
      status: 'open',
    });

    await ManagerLedgerEntry.updateMany(
      { _id: { $in: entries.map((e) => e._id) } },
      { status: 'batched', settlementBatchId: batch._id }
    );

    return res.status(201).json(batch);
  } catch (err) {
    next(err);
  }
}

export async function settleBatch(req, res, next) {
  try {
    const { batchId } = req.params;
    const adminId = req.auth?.userId || req.user?.id;

    if (!mongoose.isValidObjectId(batchId)) {
      return res.status(400).json({ message: 'Invalid batch id' });
    }

    const batch = await ManagerSettlementBatch.findById(batchId);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    if (batch.status === 'settled') {
      return res.status(400).json({ message: 'Batch already settled' });
    }

    // Cash is in hand — distribute BEFORE flipping status: credit each physio
    // his flat share and the manager her commission. Idempotent per entry, so
    // a crash here is fixed by retrying settle (batch is still open).
    const { physioPayoutTotal, commissionTotal } = await distributeSettlementBatch(batch);

    batch.status = 'settled';
    batch.settledBy = adminId;
    batch.settledAt = new Date();
    batch.physioPayoutTotal = physioPayoutTotal;
    batch.commissionTotal = commissionTotal;
    batch.distributedAt = new Date();
    await batch.save();

    await ManagerLedgerEntry.updateMany(
      { settlementBatchId: batch._id },
      { status: 'settled' }
    );

    return res.json(batch);
  } catch (err) {
    next(err);
  }
}

export async function listSettlementBatches(req, res, next) {
  try {
    const { status } = req.query || {};
    const filter = {};
    if (status) filter.status = String(status);

    const rawBatches = await ManagerSettlementBatch.find(filter)
      .sort({ createdAt: -1 })
      .populate('managerId', 'name phone')
      .limit(100)
      .lean();

    const batches = await shapeSettlementBatches(rawBatches);

    return res.json({ batches });
  } catch (err) {
    next(err);
  }
}

export async function disputeBatch(req, res, next) {
  try {
    const { batchId } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ message: 'reason is required' });

    const batch = await ManagerSettlementBatch.findById(batchId);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    if (batch.distributedAt) {
      return res.status(400).json({
        message: 'This batch was already distributed (physio/manager credited) — reverse the postings manually before disputing',
      });
    }

    batch.status = 'disputed';
    batch.notes = [batch.notes, `Disputed: ${reason}`].filter(Boolean).join('\n');
    await batch.save();

    await ManagerLedgerEntry.updateMany(
      { settlementBatchId: batch._id },
      { status: 'disputed' }
    );

    return res.json(batch);
  } catch (err) {
    next(err);
  }
}

/**
 * Remove duplicate open ledger entries from failed collection retries.
 * Groups by bookingId + amount; keeps the earliest entry, removes newer duplicates
 * created within `windowMs` of the previous entry in the group.
 */
export async function dedupeManagerLedger(req, res, next) {
  try {
    const { managerId } = req.params;
    const dryRun = req.query?.dryRun === 'true' || req.body?.dryRun === true;
    const windowMs = Math.min(
      24 * 60 * 60 * 1000,
      Math.max(60_000, Number(req.query?.windowMs || req.body?.windowMs || 5 * 60 * 1000)),
    );

    if (!mongoose.isValidObjectId(managerId)) {
      return res.status(400).json({ message: 'Invalid manager id' });
    }

    const manager = await User.findById(managerId).select('name phone role').lean();
    if (!manager || manager.role !== 'care_manager') {
      return res.status(404).json({ message: 'Care manager not found' });
    }

    const entries = await ManagerLedgerEntry.find({
      managerId,
      status: 'open',
      direction: 'credit',
    })
      .sort({ createdAt: 1 })
      .lean();

    const groups = new Map();
    for (const e of entries) {
      const key = `${e.bookingId}-${e.amount}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    const toRemove = [];
    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      for (let i = 1; i < group.length; i += 1) {
        const prevTime = new Date(group[i - 1].createdAt).getTime();
        const currTime = new Date(group[i].createdAt).getTime();
        if (currTime - prevTime <= windowMs) {
          toRemove.push(group[i]);
        }
      }
    }

    const removed = [];
    const affectedBookingIds = new Set();

    if (!dryRun && toRemove.length > 0) {
      for (const entry of toRemove) {
        await ManagerLedgerEntry.deleteOne({ _id: entry._id });
        if (entry.paymentId) {
          await Payment.deleteOne({ _id: entry.paymentId });
        }
        removed.push({
          ledgerEntryId: entry._id,
          paymentId: entry.paymentId,
          bookingId: entry.bookingId,
          amount: entry.amount,
        });
        affectedBookingIds.add(String(entry.bookingId));
      }

      for (const bookingId of affectedBookingIds) {
        await recomputeBookingPaymentRollup(bookingId);
        const booking = await Booking.findById(bookingId);
        if (booking) {
          const rows = await Payment.find({ bookingId }).lean();
          const claimed = rows
            .filter((r) => ['pending', 'paid', 'collected', 'verified'].includes(r.status))
            .reduce((s, r) => s + Number(r.amount || 0), 0);
          const totalAmount = Number(booking.totalAmount || booking.payment?.amount || 0);
          const outstanding = roundMoney2(Math.max(0, totalAmount - claimed));
          if (outstanding <= 0.009) {
            booking.paymentCollectionStatus = 'recorded';
            booking.workflowStatus = 'payment_recorded';
          } else if (claimed > 0) {
            booking.paymentCollectionStatus = 'partial';
            booking.workflowStatus = 'payment_recorded';
          }
          await booking.save();
        }
      }
    }

    const preview = toRemove.map((e) => ({
      ledgerEntryId: e._id,
      paymentId: e.paymentId,
      bookingId: e.bookingId,
      amount: e.amount,
      createdAt: e.createdAt,
    }));

    return res.json({
      dryRun,
      windowMs,
      duplicateCount: toRemove.length,
      wouldRemove: preview,
      removed: dryRun ? [] : removed,
      affectedBookings: dryRun ? [...new Set(toRemove.map((e) => String(e.bookingId)))] : [...affectedBookingIds],
    });
  } catch (err) {
    next(err);
  }
}
