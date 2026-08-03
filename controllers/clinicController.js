import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Clinic from '../models/Clinic.js';
import ClinicLedgerEntry from '../models/ClinicLedgerEntry.js';
import Payment from '../models/Payment.js';
import Physiotherapist from '../models/Physiotherapist.js';
import PlatformSettings from '../models/PlatformSettings.js';
import Transaction from '../models/Transaction.js';
import User from '../models/User.js';
import WithdrawRequest from '../models/WithdrawRequest.js';
import { computeClinicCommissionBalance } from '../utils/ledgerBalance.js';
import { previewClinicDistribution } from '../services/clinicSettlement.js';
import { isPhysioBookable } from '../utils/physioVerification.js';
import {
  getEffectiveClinicCommissionPerSessionSync,
  getEffectiveManagerCommissionPerSessionSync,
} from '../utils/pricingConfig.js';
import { deriveBookingPaymentSummary, recomputeBookingPaymentRollup } from '../utils/installmentRollup.js';
import { persistPaymentProofImage } from '../utils/paymentImagePersist.js';
import { readPagination, paginationMeta } from '../utils/pagination.js';
import { applyClinicAssignment } from '../utils/clinicAssign.js';
import { createPatientUser, CreatePatientError } from '../services/createPatientUser.js';
import { createClinicPhysio, CreateClinicPhysioError } from '../services/createClinicPhysio.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';
import {
  fireAssignmentWhatsApp,
  notifyOnClinicAssigned,
} from '../utils/assignmentWhatsApp.js';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const populateBooking = (q) =>
  q
    .populate('userId', 'name phone location coordinates pincode')
    .populate('managerId', 'name phone')
    .populate('clinicId', 'name address pincode phone')
    .populate('physioId', 'name specialization location phone experience')
    .lean();

async function resolveStaffClinic(userId) {
  const user = await User.findById(userId).select('role clinicId').lean();
  if (!user || user.role !== 'clinic_staff') return null;
  if (user.clinicId) {
    const clinic = await Clinic.findById(user.clinicId).lean();
    if (clinic?.isActive) return clinic;
  }
  const clinic = await Clinic.findOne({ staffUserIds: userId, isActive: true }).lean();
  return clinic;
}

async function loadClinicBooking(id, clinicId) {
  if (!mongoose.isValidObjectId(id)) return { error: { status: 400, message: 'Invalid booking id' } };
  const booking = await Booking.findById(id);
  if (!booking) return { error: { status: 404, message: 'Booking not found' } };
  if (String(booking.clinicId || '') !== String(clinicId)) {
    return { error: { status: 403, message: 'Forbidden' } };
  }
  return { booking };
}

async function computeOutstanding(booking) {
  const rows = await Payment.find({ bookingId: booking._id }).lean();
  const claimed = rows
    .filter((r) => ['pending', 'paid', 'collected', 'verified'].includes(r.status))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalAmount = Number(booking.totalAmount || booking.payment?.amount || 0);
  return roundMoney2(Math.max(0, totalAmount - claimed));
}

async function attachPaymentsAndSummary(booking) {
  if (!booking?._id) return { payments: [], paymentSummary: null };
  const payments = await Payment.find({ bookingId: booking._id }).sort({ createdAt: -1 }).lean();
  return {
    payments,
    paymentSummary: deriveBookingPaymentSummary(booking, payments),
  };
}

export async function getMyClinic(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned to this staff user' });
    return res.json({ clinic });
  } catch (err) {
    next(err);
  }
}

export async function listClinicBookings(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });

    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 10, maxLimit: 50 });
    const filter = { clinicId: clinic._id, serviceType: 'clinic' };
    const status = String(req.query?.status || '').trim();
    if (status) filter.status = status;

    const [items, total] = await Promise.all([
      populateBooking(Booking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
      Booking.countDocuments(filter),
    ]);

    return res.json({ items, ...paginationMeta({ page, limit, total }) });
  } catch (err) {
    next(err);
  }
}

export async function getClinicBooking(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const loaded = await loadClinicBooking(req.params.id, clinic._id);
    if (loaded.error) return res.status(loaded.error.status).json({ message: loaded.error.message });
    const out = await populateBooking(Booking.findById(loaded.booking._id));
    const { payments, paymentSummary } = await attachPaymentsAndSummary(out);
    return res.json({ ...out, payments, paymentSummary });
  } catch (err) {
    next(err);
  }
}

export async function clinicAssignPhysio(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const { physioId } = req.body || {};
    if (!mongoose.isValidObjectId(physioId)) {
      return res.status(400).json({ message: 'Invalid physiotherapist id' });
    }

    const loaded = await loadClinicBooking(req.params.id, clinic._id);
    if (loaded.error) return res.status(loaded.error.status).json({ message: loaded.error.message });
    const booking = loaded.booking;

    const allowed = (clinic.physioIds || []).some((pid) => String(pid) === String(physioId));
    if (!allowed) {
      return res.status(400).json({ message: 'Physiotherapist is not on this clinic roster' });
    }

    const physio = await Physiotherapist.findById(physioId).lean();
    if (!physio || !isPhysioBookable(physio)) {
      return res.status(400).json({ message: 'Physiotherapist not available' });
    }

    booking.physioId = physioId;
    booking.physioAssignedBy = req.user.id;
    booking.status = 'accepted';
    booking.sessionStatus = 'scheduled';
    booking.workflowStatus = 'physio_assigned';
    await booking.save();

    const out = await populateBooking(Booking.findById(booking._id));
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function listClinicPhysios(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const ids = clinic.physioIds || [];
    if (!ids.length) {
      return res.json({ physios: [], clinic: { _id: clinic._id, name: clinic.name } });
    }
    const physios = await Physiotherapist.find({ _id: { $in: ids } })
      .select(
        'name specialization phone location verificationStatus status isVerified availability isAvailable clinicId',
      )
      .sort({ name: 1 })
      .lean();
    return res.json({
      physios,
      clinic: { _id: clinic._id, name: clinic.name },
    });
  } catch (err) {
    next(err);
  }
}

export async function addClinicPhysio(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });

    const { name, phone, password, specialization } = req.body || {};
    const result = await createClinicPhysio({
      clinic,
      name,
      phone,
      password,
      specialization,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof CreateClinicPhysioError) {
      return res.status(err.status).json({ message: err.message });
    }
    next(err);
  }
}

export async function removeClinicPhysio(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });

    const physioId = req.params.physioId;
    if (!mongoose.isValidObjectId(physioId)) {
      return res.status(400).json({ message: 'Invalid physiotherapist id' });
    }

    const onRoster = (clinic.physioIds || []).some((pid) => String(pid) === String(physioId));
    if (!onRoster) {
      return res.status(404).json({ message: 'Physiotherapist is not on this clinic roster' });
    }

    await Clinic.findByIdAndUpdate(clinic._id, { $pull: { physioIds: physioId } });
    await Physiotherapist.findOneAndUpdate(
      { _id: physioId, clinicId: clinic._id },
      { $set: { clinicId: null } },
    );

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function clinicRecordCollection(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const staffId = req.user.id;
    const id = req.params.id;

    const amount = roundMoney2(Number(req.body?.amount));
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const collectionChannel = String(req.body?.collectionChannel || 'cash').trim().toLowerCase();
    const isPhonePe = collectionChannel === 'phonepe_qr';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }
    if (collectionChannel !== 'cash' && collectionChannel !== 'phonepe_qr') {
      return res.status(400).json({ message: 'collectionChannel must be cash or phonepe_qr' });
    }

    const loaded = await loadClinicBooking(id, clinic._id);
    if (loaded.error) return res.status(loaded.error.status).json({ message: loaded.error.message });
    const booking = loaded.booking;

    const outstanding = await computeOutstanding(booking);
    if (outstanding <= 0) {
      return res.status(400).json({ message: 'This booking is already fully paid' });
    }
    if (amount > outstanding + 0.009) {
      return res.status(400).json({
        message: `Cannot record more than the pending payment of Rs.${outstanding.toFixed(2)}`,
      });
    }

    let proofUrl = '';
    if (isPhonePe) {
      if (!req.file) {
        return res.status(400).json({ message: 'Payment screenshot is required for PhonePe QR collections' });
      }
      const platform = await PlatformSettings.findById('singleton').select('phonePeQrUrl').lean();
      if (!String(platform?.phonePeQrUrl || '').trim()) {
        return res.status(400).json({
          message: 'PhonePe QR is not configured. Ask admin to upload it under Platform settings.',
        });
      }
      proofUrl = await persistPaymentProofImage(req.file, String(booking._id));
    }

    const clinicPerSession = getEffectiveClinicCommissionPerSessionSync(booking);
    const managerPerSession = getEffectiveManagerCommissionPerSessionSync(booking);
    if (booking.clinicCommissionPerSession !== clinicPerSession) {
      booking.clinicCommissionPerSession = clinicPerSession;
    }
    if (booking.managerCommissionPerSession !== managerPerSession) {
      booking.managerCommissionPerSession = managerPerSession;
    }

    const planSessions = Math.max(1, Number(booking.sessions) || booking.schedule?.length || 1);
    const planTotal = Number(booking.totalAmount || 0);
    const clinicCommissionAmount =
      planTotal > 0 && clinicPerSession > 0
        ? roundMoney2(amount * ((clinicPerSession * planSessions) / planTotal))
        : 0;
    const managerCommissionAmount =
      booking.clinicSource === 'manager_referred' && planTotal > 0 && managerPerSession > 0
        ? roundMoney2(amount * ((managerPerSession * planSessions) / planTotal))
        : 0;

    const paymentPayload = {
      bookingId: booking._id,
      sessionId: null,
      physioId: booking.physioId,
      userId: booking.userId,
      amount,
      mode: 'offline',
      status: isPhonePe ? 'collected' : 'verified',
      collectedBy: null,
      collectedAt: new Date(),
      verifiedAt: isPhonePe ? null : new Date(),
      note,
      proofUrl: proofUrl || '',
      meta: {
        clinicId: String(clinic._id),
        recordedByUserId: String(staffId),
        collectionChannel: isPhonePe ? 'phonepe_qr' : 'cash',
        clinicCommissionAmount,
        ...(managerCommissionAmount > 0 ? { managerCommissionAmount } : {}),
      },
    };

    booking.paymentCollectedBy = staffId;
    booking.workflowStatus = 'payment_recorded';
    booking.paymentCollectionStatus = amount >= outstanding - 0.009 ? 'recorded' : 'partial';
    if (!isPhonePe && amount >= outstanding - 0.009) {
      booking.paymentStatus = 'held';
      booking.paidAt = booking.paidAt || new Date();
      booking.payment = {
        ...(booking.payment?.toObject?.() || booking.payment || {}),
        mode: 'offline',
        status: 'verified',
        amount: Number(booking.totalAmount || amount),
      };
    } else if (isPhonePe) {
      if (!booking.payment) booking.payment = {};
      booking.payment.mode = 'offline';
      booking.payment.status = 'collected';
    }

    let payment;
    let ledger = null;

    payment = await Payment.create(paymentPayload);
    try {
      if (!isPhonePe) {
        ledger = await ClinicLedgerEntry.create({
          clinicId: clinic._id,
          bookingId: booking._id,
          paymentId: payment._id,
          amount,
          clinicCommissionAmount,
          managerCommissionAmount,
          direction: 'credit',
          status: 'open',
          collectedAt: new Date(),
          recordedBy: staffId,
          note: note || '',
        });
      }
      await booking.save();
      await recomputeBookingPaymentRollup(booking);
    } catch (innerErr) {
      await Payment.deleteOne({ _id: payment._id });
      if (ledger?._id) await ClinicLedgerEntry.deleteOne({ _id: ledger._id });
      throw innerErr;
    }

    const out = await populateBooking(Booking.findById(id));
    const { payments, paymentSummary } = await attachPaymentsAndSummary(out);
    return res.status(201).json({
      booking: { ...out, payments, paymentSummary },
      payment,
      ledgerEntry: ledger,
    });
  } catch (err) {
    next(err);
  }
}

export async function listClinicLedger(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const status = req.query?.status ? String(req.query.status) : undefined;
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 10, maxLimit: 50 });
    const filter = { clinicId: clinic._id };
    if (status) filter.status = status;

    const [entries, total] = await Promise.all([
      ClinicLedgerEntry.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path: 'bookingId',
          select: 'issue date timeSlot totalAmount userId bookingCode clinicSource',
          populate: { path: 'userId', select: 'name phone' },
        })
        .lean(),
      ClinicLedgerEntry.countDocuments(filter),
    ]);

    const openEntries = await ClinicLedgerEntry.find({
      clinicId: clinic._id,
      status: { $in: ['open', 'batched'] },
      direction: 'credit',
    }).lean();
    const preview = await previewClinicDistribution(openEntries);

    return res.json({
      entries,
      openPreview: preview,
      ...paginationMeta({ page, limit, total }),
    });
  } catch (err) {
    next(err);
  }
}

export async function getClinicWallet(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const walletUserId = clinic.walletUserId || clinic.staffUserIds?.[0] || req.user.id;
    const balance = await computeClinicCommissionBalance(walletUserId);
    return res.json({
      clinicId: clinic._id,
      walletUserId,
      ...balance,
      payoutUpiId: clinic.payoutUpiId || '',
      payoutDisplayName: clinic.payoutDisplayName || '',
    });
  } catch (err) {
    next(err);
  }
}

export async function listClinicWalletTransactions(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const walletUserId = clinic.walletUserId || clinic.staffUserIds?.[0] || req.user.id;
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 10, maxLimit: 50 });
    const filter = {
      userId: walletUserId,
      type: { $in: ['clinic_commission', 'clinic_withdrawal'] },
    };
    const [items, total] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(filter),
    ]);
    return res.json({ items, ...paginationMeta({ page, limit, total }) });
  } catch (err) {
    next(err);
  }
}

export async function updateClinicPayout(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const payoutUpiId = String(req.body?.payoutUpiId || '').trim().slice(0, 80);
    const payoutDisplayName = String(req.body?.payoutDisplayName || '').trim().slice(0, 120);
    const updated = await Clinic.findByIdAndUpdate(
      clinic._id,
      { $set: { payoutUpiId, payoutDisplayName } },
      { new: true },
    ).lean();
    return res.json({ clinic: updated });
  } catch (err) {
    next(err);
  }
}

export async function createClinicWithdrawRequest(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const walletUserId = clinic.walletUserId || clinic.staffUserIds?.[0] || req.user.id;
    const amount = roundMoney2(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ message: 'Minimum withdrawal is ₹1' });
    }

    const existing = await WithdrawRequest.findOne({
      clinicStaffUserId: walletUserId,
      status: 'pending',
    }).lean();
    if (existing) {
      return res.status(400).json({ message: 'You already have a pending withdrawal request' });
    }

    const payoutUpiId = String(clinic.payoutUpiId || '').trim();
    if (!payoutUpiId) {
      return res.status(400).json({
        message: 'Add clinic UPI on the Finance page before requesting a withdrawal',
      });
    }

    const balance = await computeClinicCommissionBalance(walletUserId);
    if (amount > balance.availableBalance + 1e-6) {
      return res.status(400).json({
        message: `Amount exceeds withdrawable commission (₹${balance.availableBalance.toFixed(2)})`,
      });
    }

    const doc = await WithdrawRequest.create({
      clinicStaffUserId: walletUserId,
      clinicId: clinic._id,
      amount,
      status: 'pending',
      requestedAt: new Date(),
      payoutUpiId,
      payoutDisplayName: String(clinic.payoutDisplayName || clinic.name || '').trim(),
    });
    return res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
}

export async function getClinicPendingWithdraw(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });
    const walletUserId = clinic.walletUserId || clinic.staffUserIds?.[0] || req.user.id;
    const pending = await WithdrawRequest.findOne({
      clinicStaffUserId: walletUserId,
      status: 'pending',
    }).lean();
    return res.json({ pending });
  } catch (err) {
    next(err);
  }
}

/** Shared assign used by admin + manager routes. */
export async function assignClinicToBookingCore({
  bookingId,
  clinicId,
  assignedBy,
  clinicSource,
  requireManagerId = false,
  adminAssign = false,
}) {
  if (!mongoose.isValidObjectId(bookingId)) {
    return { error: { status: 400, message: 'Invalid booking id' } };
  }
  if (!mongoose.isValidObjectId(clinicId)) {
    return { error: { status: 400, message: 'Invalid clinic id' } };
  }
  const booking = await Booking.findById(bookingId);
  if (!booking) return { error: { status: 404, message: 'Booking not found' } };

  if (requireManagerId) {
    if (!booking.managerId || String(booking.managerId) !== String(assignedBy)) {
      return { error: { status: 403, message: 'Forbidden' } };
    }
    if (booking.serviceType !== 'home' && booking.serviceType !== 'clinic') {
      return { error: { status: 400, message: 'Only home cases can be referred to a clinic' } };
    }
  } else if (adminAssign) {
    // Case B: direct clinic bookings; or reassignment of any clinic-care booking.
    const isClinicCare =
      booking.serviceType === 'clinic' ||
      booking.carePath === 'clinic_visit' ||
      Boolean(booking.clinicId);
    if (!isClinicCare) {
      return {
        error: {
          status: 400,
          message: 'Only clinic appointments can be assigned here. Managers refer home cases to clinics.',
        },
      };
    }
  }

  // Never demote a manager referral to direct on reassignment.
  const resolvedSource =
    booking.clinicSource === 'manager_referred' || clinicSource === 'manager_referred'
      ? 'manager_referred'
      : clinicSource || 'direct';

  const clinic = await Clinic.findById(clinicId).lean();
  if (!clinic || !clinic.isActive) {
    return { error: { status: 400, message: 'Clinic not found or inactive' } };
  }

  applyClinicAssignment(booking, {
    clinicId,
    assignedBy,
    clinicSource: resolvedSource,
  });
  await booking.save();
  const out = await populateBooking(Booking.findById(booking._id));
  fireAssignmentWhatsApp('clinic-assigned', () => notifyOnClinicAssigned(out));
  return { booking: out };
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function attachUserAsClinicStaff(user, clinic) {
  user.role = 'clinic_staff';
  user.clinicId = clinic._id;
  await user.save();

  const clinicDoc = await Clinic.findById(clinic._id);
  if (!clinicDoc) throw new Error('Clinic not found');
  if (!clinicDoc.staffUserIds.some((id) => String(id) === String(user._id))) {
    clinicDoc.staffUserIds.push(user._id);
  }
  if (!clinicDoc.walletUserId) clinicDoc.walletUserId = user._id;
  await clinicDoc.save();
  return clinicDoc;
}

/**
 * Patients linked to this clinic.
 * source=added (default) — walk-ins created by clinic staff
 * source=bookings — patients who have a booking at this clinic
 * source=all — both
 */
export async function listClinicPatients(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });

    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 10, maxLimit: 50 });
    const search = String(req.query?.search || '').trim();
    const sourceRaw = String(req.query?.source || 'added').trim().toLowerCase();
    const source = sourceRaw === 'bookings' || sourceRaw === 'all' ? sourceRaw : 'added';

    const bookingUserIds = (
      await Booking.distinct('userId', { clinicId: clinic._id, userId: { $ne: null } })
    ).filter(Boolean);

    const scope =
      source === 'bookings'
        ? { _id: { $in: bookingUserIds } }
        : source === 'all'
          ? { $or: [{ registeredByClinicId: clinic._id }, { _id: { $in: bookingUserIds } }] }
          : { registeredByClinicId: clinic._id };

    const and = [scope];
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      and.push({ $or: [{ name: rx }, { phone: rx }] });
    }

    const filter = { role: 'user', $and: and };

    const [items, total] = await Promise.all([
      User.find(filter)
        .select('name phone location createdAt registeredByClinicId isProfileComplete')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const counts = await Booking.aggregate([
      { $match: { clinicId: clinic._id, userId: { $in: items.map((u) => u._id) } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

    return res.json({
      source,
      items: items.map((u) => ({
        ...u,
        bookingCount: countMap.get(String(u._id)) || 0,
        addedByClinic: String(u.registeredByClinicId || '') === String(clinic._id),
      })),
      ...paginationMeta({ page, limit, total }),
    });
  } catch (err) {
    next(err);
  }
}

export async function createClinicPatient(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });

    const user = await createPatientUser({
      phone: req.body?.phone,
      name: req.body?.name,
      password: req.body?.password,
      registeredByClinicId: clinic._id,
    });
    return res.status(201).json({ user });
  } catch (err) {
    if (err instanceof CreatePatientError) {
      return res.status(err.status).json({ message: err.message });
    }
    next(err);
  }
}

export async function listClinicStaffMembers(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });

    const staffIds = clinic.staffUserIds || [];
    const users = await User.find({
      $or: [{ _id: { $in: staffIds } }, { clinicId: clinic._id, role: 'clinic_staff' }],
    })
      .select('name phone role clinicId createdAt')
      .sort({ name: 1 })
      .lean();

    const walletId = String(clinic.walletUserId || '');
    return res.json({
      clinic: { _id: clinic._id, name: clinic.name },
      items: users.map((u) => ({
        ...u,
        isWalletOwner: walletId && String(u._id) === walletId,
        isSelf: String(u._id) === String(req.user.id),
      })),
    });
  } catch (err) {
    next(err);
  }
}

/** Create a new login for clinic staff, or promote an existing patient/user by phone. */
export async function addClinicStaffMember(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });

    const phoneRaw = req.body?.phone;
    const name = String(req.body?.name || '').trim();
    const password = req.body?.password;
    const existingUserId = req.body?.userId;

    let user;
    if (existingUserId && mongoose.isValidObjectId(existingUserId)) {
      user = await User.findById(existingUserId);
      if (!user) return res.status(404).json({ message: 'User not found' });
    } else {
      const pv = validateIndianMobile(phoneRaw);
      if (!pv.valid) return res.status(400).json({ message: pv.message });
      user = await User.findOne({ phone: pv.normalized });
      if (!user) {
        const created = await createPatientUser({ phone: phoneRaw, name, password });
        user = await User.findById(created._id);
      } else if (name.length >= 2 && !user.name) {
        user.name = name;
      }
    }

    if (user.role === 'admin') {
      return res.status(400).json({ message: 'Cannot change admin role' });
    }
    if (user.role === 'physio' || user.role === 'care_manager') {
      return res.status(400).json({ message: 'This account already has another staff role' });
    }
    if (user.role === 'clinic_staff' && user.clinicId && String(user.clinicId) !== String(clinic._id)) {
      return res.status(409).json({ message: 'This person already belongs to another clinic' });
    }
    if (user.role === 'clinic_staff' && String(user.clinicId || '') === String(clinic._id)) {
      return res.status(409).json({ message: 'This person already has access to your clinic' });
    }

    const clinicDoc = await attachUserAsClinicStaff(user, clinic);
    return res.status(201).json({
      user: {
        _id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        clinicId: user.clinicId,
        isWalletOwner: String(clinicDoc.walletUserId || '') === String(user._id),
      },
    });
  } catch (err) {
    if (err instanceof CreatePatientError) {
      return res.status(err.status).json({ message: err.message });
    }
    next(err);
  }
}

export async function removeClinicStaffMember(req, res, next) {
  try {
    const clinic = await resolveStaffClinic(req.user?.id);
    if (!clinic) return res.status(404).json({ message: 'No clinic assigned' });

    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    if (String(userId) === String(req.user.id)) {
      return res.status(400).json({ message: 'You cannot remove yourself' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const isMember =
      String(user.clinicId || '') === String(clinic._id) ||
      (clinic.staffUserIds || []).some((id) => String(id) === String(userId));
    if (!isMember) {
      return res.status(404).json({ message: 'This person is not staff at your clinic' });
    }

    if (String(clinic.walletUserId || '') === String(userId)) {
      return res.status(400).json({
        message: 'This person holds the clinic wallet. Ask admin to reassign the wallet before removing them.',
      });
    }

    const clinicDoc = await Clinic.findById(clinic._id);
    clinicDoc.staffUserIds = (clinicDoc.staffUserIds || []).filter((id) => String(id) !== String(userId));
    await clinicDoc.save();

    if (user.role === 'clinic_staff') {
      user.role = 'user';
      user.clinicId = null;
      await user.save();
    }

    return res.json({ ok: true, removedId: userId });
  } catch (err) {
    next(err);
  }
}

export { applyClinicAssignment };
