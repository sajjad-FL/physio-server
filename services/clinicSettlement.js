import Booking from '../models/Booking.js';
import Clinic from '../models/Clinic.js';
import ClinicLedgerEntry from '../models/ClinicLedgerEntry.js';
import Transaction from '../models/Transaction.js';
import {
  getEffectiveClinicCommissionPerSessionSync,
  getEffectiveManagerCommissionPerSessionSync,
} from '../utils/pricingConfig.js';

const POSTED = 'posted';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Clinic visit split: clinic + optional manager (referred) + platform remainder.
 */
export function computeClinicEntryShares(entry, booking) {
  const amount = roundMoney2(Number(entry.amount) || 0);
  if (amount <= 0) {
    return { clinicShare: 0, managerShare: 0, platformShare: 0, skippedReason: 'zero_amount' };
  }
  if (!booking) {
    return { clinicShare: 0, managerShare: 0, platformShare: amount, skippedReason: 'no_booking' };
  }

  const totalAmount = Number(booking.totalAmount || booking.payment?.amount || 0);
  const sessions = Math.max(1, Number(booking.sessions) || booking.schedule?.length || 1);

  let clinicShare;
  if (entry.clinicCommissionAmount != null) {
    clinicShare = roundMoney2(Number(entry.clinicCommissionAmount) || 0);
  } else {
    const perSession = getEffectiveClinicCommissionPerSessionSync(booking);
    clinicShare =
      totalAmount > 0 && perSession > 0
        ? roundMoney2(amount * ((perSession * sessions) / totalAmount))
        : 0;
  }

  let managerShare = 0;
  if (booking.clinicSource === 'manager_referred' && booking.managerId) {
    if (entry.managerCommissionAmount != null) {
      managerShare = roundMoney2(Number(entry.managerCommissionAmount) || 0);
    } else {
      const perSession = getEffectiveManagerCommissionPerSessionSync(booking);
      managerShare =
        totalAmount > 0 && perSession > 0
          ? roundMoney2(amount * ((perSession * sessions) / totalAmount))
          : 0;
    }
  }

  clinicShare = Math.min(clinicShare, amount);
  managerShare = Math.max(0, Math.min(managerShare, roundMoney2(amount - clinicShare)));
  const platformShare = roundMoney2(amount - clinicShare - managerShare);

  return { clinicShare, managerShare, platformShare, skippedReason: '' };
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
      'clinicId clinicSource managerId clinicCommissionPerSession managerCommissionPerSession totalAmount sessions schedule payment serviceType carePath',
    )
    .lean();
  return new Map(bookings.map((b) => [String(b._id), b]));
}

export async function previewClinicDistribution(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const bookingMap = await loadBookingsForEntries(list);
  let clinicTotal = 0;
  let managerTotal = 0;
  let platformTotal = 0;
  for (const entry of list) {
    if (entry.direction === 'debit') continue;
    const shares = entry.distribution?.distributedAt
      ? entry.distribution
      : computeClinicEntryShares(
          entry,
          bookingMap.get(
            String(entry.bookingId && typeof entry.bookingId === 'object' ? entry.bookingId._id : entry.bookingId),
          ),
        );
    clinicTotal += Number(shares.clinicShare) || 0;
    managerTotal += Number(shares.managerShare) || 0;
    platformTotal += Number(shares.platformShare) || 0;
  }
  return {
    clinicTotal: roundMoney2(clinicTotal),
    managerTotal: roundMoney2(managerTotal),
    platformTotal: roundMoney2(platformTotal),
  };
}

function isDuplicateKeyError(err) {
  return err?.code === 11000;
}

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

async function resolveClinicWalletUserId(clinicId) {
  const clinic = await Clinic.findById(clinicId).select('walletUserId staffUserIds').lean();
  if (!clinic) return null;
  if (clinic.walletUserId) return clinic.walletUserId;
  return clinic.staffUserIds?.[0] || null;
}

export async function distributeClinicSettlementBatch(batch) {
  const entries = await ClinicLedgerEntry.find({
    _id: { $in: batch.ledgerEntryIds || [] },
    direction: 'credit',
  });
  const bookingMap = await loadBookingsForEntries(entries);
  const walletUserId = await resolveClinicWalletUserId(batch.clinicId);

  let clinicCommissionTotal = 0;
  let managerCommissionTotal = 0;

  for (const entry of entries) {
    if (entry.distribution?.distributedAt) {
      clinicCommissionTotal += Number(entry.distribution.clinicShare) || 0;
      managerCommissionTotal += Number(entry.distribution.managerShare) || 0;
      continue;
    }

    const booking = bookingMap.get(String(entry.bookingId));
    const shares = computeClinicEntryShares(entry, booking);
    const payKey = String(entry.paymentId || entry._id);

    if (shares.clinicShare > 0 && walletUserId) {
      await postOnce(
        {
          bookingId: entry.bookingId,
          physioId: null,
          type: 'clinic_commission',
          direction: 'credit',
          status: POSTED,
          'meta.leg': 'commission',
          'meta.paymentId': payKey,
        },
        {
          bookingId: entry.bookingId,
          userId: walletUserId,
          physioId: null,
          type: 'clinic_commission',
          totalAmount: shares.clinicShare,
          commission: shares.clinicShare,
          physioEarning: 0,
          direction: 'credit',
          status: POSTED,
          meta: {
            leg: 'commission',
            paymentId: payKey,
            settlementBatchId: String(batch._id),
            clinicLedgerEntryId: String(entry._id),
            clinicId: String(entry.clinicId),
          },
        },
      );
    }

    if (shares.managerShare > 0 && booking?.managerId) {
      await postOnce(
        {
          bookingId: entry.bookingId,
          physioId: null,
          type: 'manager_commission',
          direction: 'credit',
          status: POSTED,
          'meta.leg': 'commission',
          'meta.paymentId': `clinic_${payKey}`,
        },
        {
          bookingId: entry.bookingId,
          userId: booking.managerId,
          physioId: null,
          type: 'manager_commission',
          totalAmount: shares.managerShare,
          commission: shares.managerShare,
          physioEarning: 0,
          direction: 'credit',
          status: POSTED,
          meta: {
            leg: 'commission',
            paymentId: `clinic_${payKey}`,
            settlementBatchId: String(batch._id),
            clinicLedgerEntryId: String(entry._id),
            source: 'clinic_settlement',
          },
        },
      );
    }

    entry.distribution = {
      clinicShare: shares.clinicShare,
      managerShare: shares.managerShare,
      platformShare: shares.platformShare,
      distributedAt: new Date(),
      skippedReason: shares.skippedReason || '',
    };
    await entry.save();

    clinicCommissionTotal += shares.clinicShare;
    managerCommissionTotal += shares.managerShare;
  }

  return {
    clinicCommissionTotal: roundMoney2(clinicCommissionTotal),
    managerCommissionTotal: roundMoney2(managerCommissionTotal),
  };
}

export async function distributeClinicPhonePePayment(booking, payment) {
  const amount = roundMoney2(Number(payment?.amount) || 0);
  if (amount <= 0 || !booking) {
    return { clinicShare: 0, managerShare: 0, platformShare: 0 };
  }

  const fakeEntry = {
    amount,
    clinicCommissionAmount: payment?.meta?.clinicCommissionAmount,
    managerCommissionAmount: payment?.meta?.managerCommissionAmount,
    paymentId: payment._id,
    clinicId: booking.clinicId,
    bookingId: booking._id,
  };
  const shares = computeClinicEntryShares(fakeEntry, booking);
  const payKey = String(payment._id);
  const walletUserId = await resolveClinicWalletUserId(booking.clinicId);

  if (shares.clinicShare > 0 && walletUserId) {
    await postOnce(
      {
        bookingId: booking._id,
        physioId: null,
        type: 'clinic_commission',
        direction: 'credit',
        status: POSTED,
        'meta.leg': 'commission',
        'meta.paymentId': payKey,
      },
      {
        bookingId: booking._id,
        userId: walletUserId,
        physioId: null,
        type: 'clinic_commission',
        totalAmount: shares.clinicShare,
        commission: shares.clinicShare,
        physioEarning: 0,
        direction: 'credit',
        status: POSTED,
        meta: {
          leg: 'commission',
          paymentId: payKey,
          source: 'clinic_phonepe',
          clinicId: String(booking.clinicId),
        },
      },
    );
  }

  if (shares.managerShare > 0 && booking.managerId) {
    await postOnce(
      {
        bookingId: booking._id,
        physioId: null,
        type: 'manager_commission',
        direction: 'credit',
        status: POSTED,
        'meta.leg': 'commission',
        'meta.paymentId': `clinic_${payKey}`,
      },
      {
        bookingId: booking._id,
        userId: booking.managerId,
        physioId: null,
        type: 'manager_commission',
        totalAmount: shares.managerShare,
        commission: shares.managerShare,
        physioEarning: 0,
        direction: 'credit',
        status: POSTED,
        meta: {
          leg: 'commission',
          paymentId: `clinic_${payKey}`,
          source: 'clinic_phonepe',
        },
      },
    );
  }

  return shares;
}
