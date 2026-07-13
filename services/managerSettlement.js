import Booking from '../models/Booking.js';
import ManagerLedgerEntry from '../models/ManagerLedgerEntry.js';
import Transaction from '../models/Transaction.js';
import {
  getEffectiveManagerCommissionPerSessionSync,
  isTechniqueIssue,
} from '../utils/pricingConfig.js';

const POSTED = 'posted';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Compute one ledger entry's three-way split (pure, no writes).
 *
 * Proportional attribution: for a collection of `amount` on a plan with patient
 * total `T`, physio target `P = physioRatePerSession × sessions` and manager
 * target `M = managerCommissionPerSession × sessions`:
 *   physioShare  = round2(amount × P / T)
 *   managerShare = round2(amount × M / T)   (pre-computed at collection time)
 *   platform     = amount − physioShare − managerShare  (incl. travel surcharge)
 * A fully collected plan pays out exactly P and M (± paise drift absorbed by
 * the platform share). Legacy bookings without a flat rate fall back to the
 * percent model stored on booking.payment; if neither exists the physio leg is
 * skipped (never throws — old data must not block settlement).
 */
export function computeEntryShares(entry, booking) {
  const amount = roundMoney2(Number(entry.amount) || 0);
  if (amount <= 0) {
    return { physioShare: 0, managerShare: 0, platformShare: 0, physioBasis: null, skippedReason: 'zero_amount' };
  }
  if (!booking) {
    return { physioShare: 0, managerShare: 0, platformShare: amount, physioBasis: null, skippedReason: 'no_booking' };
  }

  const totalAmount = Number(booking.totalAmount || booking.payment?.amount || 0);
  const sessions = Math.max(1, Number(booking.sessions) || booking.schedule?.length || 1);

  let physioShare = 0;
  let physioBasis = null;
  let skippedReason = '';
  const flatRate = Number(booking.physioRatePerSession);
  const legacyEarning = Number(booking.payment?.physioEarning);
  const legacyAmount = Number(booking.payment?.amount);
  if (!booking.physioId) {
    skippedReason = 'no_physio';
  } else if (Number.isFinite(flatRate) && flatRate > 0 && totalAmount > 0) {
    physioShare = roundMoney2(amount * ((flatRate * sessions) / totalAmount));
    physioBasis = 'flat_rate';
  } else if (Number.isFinite(legacyEarning) && legacyEarning > 0 && legacyAmount > 0) {
    // Pre-feature booking: percent-of-gross model stored by applyHomePlanFields.
    physioShare = roundMoney2(amount * (legacyEarning / legacyAmount));
    physioBasis = 'percent_model';
  } else {
    skippedReason = 'no_physio_rate';
  }

  let managerShare;
  // Technique bookings always take Care manager ₹ from Techniques pricing.
  // Unsettled ledger rows may still hold the old Defaults-based cut (e.g. ₹30).
  const recomputeManager =
    isTechniqueIssue(booking.issue) || entry.managerCommissionAmount == null;
  if (!recomputeManager) {
    managerShare = roundMoney2(Number(entry.managerCommissionAmount) || 0);
  } else {
    const perSession = getEffectiveManagerCommissionPerSessionSync(booking);
    managerShare =
      totalAmount > 0 && perSession > 0
        ? roundMoney2(amount * ((perSession * sessions) / totalAmount))
        : 0;
  }

  // Money conservation guard (legacy/edge data): never distribute more than collected.
  physioShare = Math.min(physioShare, amount);
  managerShare = Math.max(0, Math.min(managerShare, roundMoney2(amount - physioShare)));
  const platformShare = roundMoney2(amount - physioShare - managerShare);

  return { physioShare, managerShare, platformShare, physioBasis, skippedReason };
}

async function loadBookingsForEntries(entries) {
  const ids = [
    ...new Set(
      entries
        .map((e) => (e.bookingId && typeof e.bookingId === 'object' ? e.bookingId._id : e.bookingId))
        .filter(Boolean)
        .map(String),
    ),
  ];
  if (!ids.length) return new Map();
  const bookings = await Booking.find({ _id: { $in: ids } })
    .select(
      'issue carePath physioId physioRatePerSession managerCommissionPerSession totalAmount sessions schedule payment',
    )
    .lean();
  return new Map(bookings.map((b) => [String(b._id), b]));
}

/**
 * Dry-run totals for a set of ledger entries (admin "on settle" preview).
 * Already-distributed entries report their stored shares.
 */
export async function previewDistribution(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const bookingMap = await loadBookingsForEntries(list);
  let physioTotal = 0;
  let managerTotal = 0;
  let platformTotal = 0;
  for (const entry of list) {
    if (entry.direction === 'debit') continue;
    const shares = entry.distribution?.distributedAt
      ? entry.distribution
      : computeEntryShares(
          entry,
          bookingMap.get(
            String(entry.bookingId && typeof entry.bookingId === 'object' ? entry.bookingId._id : entry.bookingId),
          ),
        );
    physioTotal += Number(shares.physioShare) || 0;
    managerTotal += Number(shares.managerShare) || 0;
    platformTotal += Number(shares.platformShare) || 0;
  }
  return {
    physioTotal: roundMoney2(physioTotal),
    managerTotal: roundMoney2(managerTotal),
    platformTotal: roundMoney2(platformTotal),
  };
}

function isDuplicateKeyError(err) {
  return err?.code === 11000;
}

/**
 * Post one idempotent Transaction; tolerate the unique index rejecting a retry.
 */
async function postOnce(filter, doc) {
  const existing = await Transaction.findOne(filter).lean();
  if (existing) return { created: false, reason: 'duplicate' };
  try {
    await Transaction.create(doc);
    return { created: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) return { created: false, reason: 'duplicate' };
    throw err;
  }
}

/**
 * Distribute a settled cash hand-off: credit each booking's physio his flat
 * share and the manager her commission, per ledger entry.
 *
 * Retry-safe without a Mongo transaction: every posting is idempotent (unique
 * `uniq_posted_leg_per_payment` index + findOne-first), each entry records
 * `distribution.distributedAt` when done, and callers only flip the batch to
 * `settled` after this returns. A crash mid-way is fixed by re-running settle.
 *
 * @returns {{ physioPayoutTotal: number, commissionTotal: number }}
 */
export async function distributeSettlementBatch(batch) {
  const entries = await ManagerLedgerEntry.find({
    _id: { $in: batch.ledgerEntryIds || [] },
    direction: 'credit',
  });
  const bookingMap = await loadBookingsForEntries(entries);

  let physioPayoutTotal = 0;
  let commissionTotal = 0;

  for (const entry of entries) {
    if (entry.distribution?.distributedAt) {
      physioPayoutTotal += Number(entry.distribution.physioShare) || 0;
      commissionTotal += Number(entry.distribution.managerShare) || 0;
      continue;
    }

    const booking = bookingMap.get(String(entry.bookingId));
    const shares = computeEntryShares(entry, booking);
    const payKey = String(entry.paymentId || entry._id);

    if (shares.physioShare > 0 && booking?.physioId) {
      // `online/earning` leg so getComputedWallet counts it as withdrawable —
      // the physio never held this cash (the manager collected it).
      await postOnce(
        {
          bookingId: booking._id,
          physioId: booking.physioId,
          type: 'online',
          direction: 'credit',
          status: POSTED,
          'meta.leg': 'earning',
          'meta.paymentId': payKey,
        },
        {
          bookingId: booking._id,
          physioId: booking.physioId,
          type: 'online',
          totalAmount: shares.physioShare,
          commission: 0,
          physioEarning: shares.physioShare,
          direction: 'credit',
          status: POSTED,
          meta: {
            leg: 'earning',
            paymentId: payKey,
            source: 'manager_settlement',
            settlementBatchId: String(batch._id),
            managerLedgerEntryId: String(entry._id),
            physioBasis: shares.physioBasis,
          },
        },
      );
    }

    if (shares.managerShare > 0 && entry.managerId) {
      await postOnce(
        {
          bookingId: entry.bookingId,
          physioId: null,
          type: 'manager_commission',
          direction: 'credit',
          status: POSTED,
          'meta.leg': 'commission',
          'meta.paymentId': payKey,
        },
        {
          bookingId: entry.bookingId,
          userId: entry.managerId,
          physioId: null,
          type: 'manager_commission',
          totalAmount: shares.managerShare,
          commission: shares.managerShare,
          physioEarning: 0,
          direction: 'credit',
          status: POSTED,
          meta: {
            leg: 'commission',
            paymentId: payKey,
            settlementBatchId: String(batch._id),
            managerLedgerEntryId: String(entry._id),
          },
        },
      );
    }

    entry.distribution = {
      physioShare: shares.physioShare,
      managerShare: shares.managerShare,
      platformShare: shares.platformShare,
      distributedAt: new Date(),
      skippedReason: shares.skippedReason || '',
    };
    if (isTechniqueIssue(booking?.issue)) {
      entry.managerCommissionAmount = shares.managerShare;
    }
    await entry.save();

    physioPayoutTotal += shares.physioShare;
    commissionTotal += shares.managerShare;
  }

  return {
    physioPayoutTotal: roundMoney2(physioPayoutTotal),
    commissionTotal: roundMoney2(commissionTotal),
  };
}

/**
 * Credit physio + manager after admin verifies a manager PhonePe QR collection.
 * Money already landed on the platform QR — no cash ledger / settlement batch.
 */
export async function distributeManagerPhonePePayment(booking, payment) {
  const amount = roundMoney2(Number(payment?.amount) || 0);
  if (amount <= 0 || !booking) {
    return { physioShare: 0, managerShare: 0, platformShare: 0 };
  }

  const managerId = payment?.meta?.managerId || booking.managerId;
  const snapCommission = Number(payment?.meta?.managerCommissionAmount);
  const entry = {
    amount,
    managerCommissionAmount: Number.isFinite(snapCommission) ? snapCommission : null,
  };
  const shares = computeEntryShares(entry, booking);
  const payKey = String(payment._id);

  if (shares.physioShare > 0 && booking.physioId) {
    await postOnce(
      {
        bookingId: booking._id,
        physioId: booking.physioId,
        type: 'online',
        direction: 'credit',
        status: POSTED,
        'meta.leg': 'earning',
        'meta.paymentId': payKey,
      },
      {
        bookingId: booking._id,
        physioId: booking.physioId,
        type: 'online',
        totalAmount: shares.physioShare,
        commission: 0,
        physioEarning: shares.physioShare,
        direction: 'credit',
        status: POSTED,
        meta: {
          leg: 'earning',
          paymentId: payKey,
          source: 'manager_phonepe_qr',
          physioBasis: shares.physioBasis,
        },
      },
    );
  }

  if (shares.managerShare > 0 && managerId) {
    await postOnce(
      {
        bookingId: booking._id,
        physioId: null,
        type: 'manager_commission',
        direction: 'credit',
        status: POSTED,
        'meta.leg': 'commission',
        'meta.paymentId': payKey,
      },
      {
        bookingId: booking._id,
        userId: managerId,
        physioId: null,
        type: 'manager_commission',
        totalAmount: shares.managerShare,
        commission: shares.managerShare,
        physioEarning: 0,
        direction: 'credit',
        status: POSTED,
        meta: {
          leg: 'commission',
          paymentId: payKey,
          source: 'manager_phonepe_qr',
        },
      },
    );
  }

  return shares;
}
