import mongoose from 'mongoose';
import { validateIndianMobile } from '../utils/phoneIndia.js';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { displayVerificationStatus } from '../utils/physioVerification.js';
import Dispute from '../models/Dispute.js';
import Booking from '../models/Booking.js';
import WithdrawRequest from '../models/WithdrawRequest.js';
import { listAllPhysioWalletsSummary } from '../utils/ledgerBalance.js';
import { releaseEscrowBooking } from '../utils/releaseEscrow.js';
import { postOnlineRefundDebit } from '../services/ledger.js';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 10));
  return { page, limit, skip: (page - 1) * limit };
}

/** Sidebar badges: actionable counts per admin section. */
export async function getAdminNavCounts(_req, res, next) {
  try {
    const offlineQueueBase = {
      serviceType: 'home',
      homePlanPaymentMode: 'offline',
      planStatus: 'approved',
    };

    const [
      bookings,
      payments,
      withdrawals,
      physiosPending,
      verifications,
      disputes,
      walletRows,
    ] = await Promise.all([
      Booking.countDocuments({
        status: 'pending',
        $or: [{ physioId: null }, { physioId: { $exists: false } }],
      }),
      Booking.countDocuments({
        ...offlineQueueBase,
        'payment.status': { $in: ['pending', 'collected'] },
      }),
      WithdrawRequest.countDocuments({ status: 'pending' }),
      Physiotherapist.countDocuments({ verificationStatus: 'pending' }),
      Physiotherapist.countDocuments({ verificationStatus: { $ne: 'approved' } }),
      Dispute.countDocuments({ status: { $in: ['open', 'under_review'] } }),
      listAllPhysioWalletsSummary(),
    ]);

    const settlements = walletRows.filter((r) => Number(r.wallet?.commissionDue || 0) > 0.009).length;

    return res.json({
      bookings,
      payments,
      withdrawals,
      settlements,
      physios: physiosPending,
      verifications,
      disputes,
      platform: 0,
    });
  } catch (err) {
    next(err);
  }
}

export async function listPhysioVerifications(req, res, next) {
  try {
    const list = await Physiotherapist.find({ verificationStatus: { $ne: 'approved' } })
      .sort({ updatedAt: -1 })
      .lean();

    return res.json(list);
  } catch (err) {
    next(err);
  }
}

export async function patchPhysioVerification(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }

    const { verificationStatus, verificationNote, isVerified } = req.body || {};
    const updates = {};

    if (verificationStatus === 'approved' || verificationStatus === 'rejected' || verificationStatus === 'pending') {
      updates.verificationStatus = verificationStatus;
      updates.status = verificationStatus;
      if (verificationStatus === 'approved') {
        updates['verification.status'] = 'verified';
        if (!updates['verification.level']) updates['verification.level'] = 'verified';
      } else if (verificationStatus === 'rejected') {
        updates['verification.status'] = 'rejected';
        updates['verification.level'] = 'not_verified';
      } else {
        updates['verification.status'] = 'pending';
        updates['verification.level'] = 'not_verified';
      }
    }
    if (typeof verificationNote === 'string') {
      updates.verificationNote = verificationNote.trim();
    }
    if (typeof isVerified === 'boolean') {
      updates.isVerified = isVerified;
    } else if (verificationStatus === 'approved') {
      updates.isVerified = true;
    } else if (verificationStatus === 'rejected') {
      updates.isVerified = false;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid updates' });
    }

    const physio = await Physiotherapist.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

export async function listDisputes(req, res, next) {
  try {
    const { page, limit, skip } = readPagination(req.query);
    const bookingId = req.query.bookingId;
    const filter = {};
    if (bookingId && mongoose.isValidObjectId(String(bookingId))) {
      filter.bookingId = bookingId;
    }
    const [list, total] = await Promise.all([
      Dispute.find(filter)
      .populate({
        path: 'bookingId',
        select:
          'date timeSlot issue paymentStatus sessionStatus status userId physioId amountPaise',
        populate: [
          { path: 'userId', select: 'name phone' },
          { path: 'physioId', select: 'name phone specialization' },
        ],
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
      Dispute.countDocuments(filter),
    ]);

    return res.json({
      data: list,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}

export async function resolveAdminDispute(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }

    const { resolution, action } = req.body || {};
    if (!String(resolution || '').trim()) {
      return res.status(400).json({ message: 'resolution is required' });
    }
    if (!['refund', 'release', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action must be refund, release, or reject' });
    }

    const dispute = await Dispute.findById(id);
    if (!dispute) return res.status(404).json({ message: 'Not found' });
    if (dispute.status === 'resolved' || dispute.status === 'rejected') {
      return res.status(400).json({ message: 'Dispute is already closed' });
    }

    const booking = await Booking.findById(dispute.bookingId);
    if (!booking && action !== 'reject') {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (action === 'reject') {
      dispute.status = 'rejected';
      dispute.resolution = String(resolution).trim();
      await dispute.save();
    } else if (action === 'refund') {
      if (booking && !['held', 'pending'].includes(booking.paymentStatus)) {
        return res
          .status(400)
          .json({ message: 'Refund only applies when payment is pending or held' });
      }
      if (booking) {
        booking.paymentStatus = 'refunded';
        if (booking.payment?.status === 'paid' && booking.physioId) {
          await postOnlineRefundDebit(booking);
        }
        booking.payment = booking.payment || {};
        booking.payment.status = 'refunded';
        await booking.save();
      }
      dispute.status = 'resolved';
      dispute.resolution = String(resolution).trim();
      await dispute.save();
    } else if (action === 'release') {
      if (booking.paymentStatus !== 'held') {
        return res.status(400).json({ message: 'Release only applies when payment is in secure hold' });
      }
      try {
        await releaseEscrowBooking(booking, { requireNotesAndSession: false });
      } catch (e) {
        const statusCode = e.statusCode || 500;
        return res.status(statusCode).json({ message: e.message || 'Release failed' });
      }
      dispute.status = 'resolved';
      dispute.resolution = String(resolution).trim();
      await dispute.save();
    }

    const populated = await Dispute.findById(id)
      .populate({
        path: 'bookingId',
        select:
          'date timeSlot issue paymentStatus sessionStatus status userId physioId amountPaise',
        populate: [
          { path: 'userId', select: 'name phone' },
          { path: 'physioId', select: 'name phone specialization' },
        ],
      })
      .lean();

    return res.json(populated);
  } catch (err) {
    next(err);
  }
}

export async function listAdminUsers(req, res, next) {
  try {
    const withoutPhysio = String(req.query.withoutPhysio || '').toLowerCase() === 'true';
    const filter = {};
    if (withoutPhysio) {
      filter.$or = [{ physioId: null }, { physioId: { $exists: false } }];
    }

    const list = await User.find(filter)
      .select('name phone location role physioId coordinates createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const mapped = list.map((u) => ({
      _id: u._id,
      name: u.name,
      phone: u.phone,
      location: u.location,
      role: u.role || 'user',
      physioId: u.physioId,
      isLinkedPhysio: Boolean(u.physioId),
    }));

    return res.json(mapped);
  } catch (err) {
    next(err);
  }
}

export async function createPhysioFromUser(req, res, next) {
  try {
    const { userId, specialization, name, location, lat, lng, availability } = req.body || {};

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Valid userId is required' });
    }
    if (!String(specialization || '').trim()) {
      return res.status(400).json({ message: 'specialization is required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (user.physioId) {
      return res.status(409).json({ message: 'User is already linked to a physiotherapist profile' });
    }
    if (!String(user.phone || '').trim()) {
      return res.status(400).json({ message: 'User must have a phone number' });
    }

    const pv = validateIndianMobile(user.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message || 'User phone must be a valid 10-digit Indian mobile' });
    }
    const phoneNorm = pv.normalized;
    const phoneTaken = await Physiotherapist.findOne({ phone: phoneNorm }).lean();
    if (phoneTaken) {
      return res.status(409).json({ message: 'A physiotherapist with this phone already exists' });
    }

    const finalName = String(name || user.name || '').trim() || 'Physiotherapist';
    const finalLocation = String(location || user.location || '').trim();
    if (!finalLocation) {
      return res
        .status(400)
        .json({ message: 'location is required — add it to the user profile or send it in the request' });
    }

    let coordinates = user.coordinates || null;
    if (lat != null && lng != null) {
      const la = Number(lat);
      const ln = Number(lng);
      if (!Number.isNaN(la) && !Number.isNaN(ln)) {
        coordinates = { lat: la, lng: ln };
      }
    }

    const physio = await Physiotherapist.create({
      name: finalName,
      specialization: specialization.trim(),
      location: finalLocation,
      phone: phoneNorm,
      coordinates,
      availability: availability !== undefined ? Boolean(availability) : true,
      verificationStatus: 'pending',
      status: 'pending',
      isVerified: false,
      documents: [],
    });

    try {
      if (user.phone !== phoneNorm) {
        user.phone = phoneNorm;
      }
      user.physioId = physio._id;
      user.role = 'physio';
      await user.save();
    } catch (e) {
      await Physiotherapist.findByIdAndDelete(physio._id);
      throw e;
    }

    return res.status(201).json({
      physio: physio.toObject(),
      user: {
        _id: user._id,
        role: user.role,
        physioId: user.physioId,
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: 'Phone already registered' });
    }
    next(err);
  }
}

export async function listAdminPhysios(_req, res, next) {
  try {
    const { page, limit, skip } = readPagination(_req.query);
    const [list, total] = await Promise.all([
      Physiotherapist.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Physiotherapist.countDocuments(),
    ]);
    const data = list.map((p) => ({
      ...p,
      displayVerificationStatus: displayVerificationStatus(p),
    }));
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

export async function getAdminPhysioById(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid physiotherapist id' });
    }
    const physio = await Physiotherapist.findById(id).lean();
    if (!physio) return res.status(404).json({ message: 'Physiotherapist not found' });
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

export async function patchAdminPhysio(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid physiotherapist id' });
    }

    const { name, experience, pricePerSession, pricePerSessionMax, specialization, isAvailable, availability } =
      req.body || {};
    const updates = {};

    if (typeof name === 'string' && name.trim()) updates.name = name.trim();
    if (typeof specialization === 'string' && specialization.trim()) {
      updates.specialization = specialization.trim();
    }
    if (experience !== undefined) {
      const value = Number(experience);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ message: 'experience must be a non-negative number' });
      }
      updates.experience = value;
    }
    if (pricePerSession !== undefined) {
      const value = Number(pricePerSession);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ message: 'pricePerSession must be a non-negative number' });
      }
      updates.pricePerSession = value;
    }
    if (pricePerSessionMax !== undefined) {
      if (pricePerSessionMax === null || pricePerSessionMax === '') {
        updates.pricePerSessionMax = null;
      } else {
        const hi = Number(pricePerSessionMax);
        if (!Number.isFinite(hi) || hi < 0) {
          return res.status(400).json({ message: 'pricePerSessionMax must be a non-negative number or empty' });
        }
        const existing = await Physiotherapist.findById(id).select('pricePerSession').lean();
        const lo = updates.pricePerSession ?? Number(existing?.pricePerSession);
        if (Number.isFinite(hi) && Number.isFinite(lo) && hi > lo) {
          updates.pricePerSessionMax = hi;
        } else {
          updates.pricePerSessionMax = null;
        }
      }
    }
    if (typeof isAvailable === 'boolean') {
      updates.isAvailable = isAvailable;
      updates.availability = isAvailable;
    } else if (typeof availability === 'boolean') {
      updates.isAvailable = availability;
      updates.availability = availability;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    const physio = await Physiotherapist.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!physio) return res.status(404).json({ message: 'Physiotherapist not found' });
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

export async function verifyAdminPhysio(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid physiotherapist id' });
    }

    const raw = String(req.body?.status || '').trim();
    const approve = raw === 'verified' || raw === 'approved';
    const reject = raw === 'rejected';
    if (!approve && !reject) {
      return res.status(400).json({ message: 'status must be verified, approved, or rejected' });
    }

    const rejectionReason = reject ? String(req.body?.rejectionReason || '').trim() : '';

    const $set = approve
      ? {
          'verification.status': 'verified',
          'verification.level': 'verified',
          'verification.rejectionReason': '',
          verificationStatus: 'approved',
          status: 'approved',
          isVerified: true,
        }
      : {
          'verification.status': 'rejected',
          'verification.level': 'not_verified',
          'verification.rejectionReason': rejectionReason,
          verificationStatus: 'rejected',
          status: 'rejected',
          isVerified: false,
        };

    const physio = await Physiotherapist.findByIdAndUpdate(id, { $set }, { new: true }).lean();
    if (!physio) return res.status(404).json({ message: 'Physiotherapist not found' });
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

export async function listPendingPhysios(_req, res, next) {
  try {
    const data = await Physiotherapist.find({ verificationStatus: 'pending' })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ data });
  } catch (err) {
    next(err);
  }
}

export function approvePhysioAdmin(req, res, next) {
  req.body = { ...(req.body || {}), status: 'approved' };
  return verifyAdminPhysio(req, res, next);
}

export function rejectPhysioAdmin(req, res, next) {
  req.body = { ...(req.body || {}), status: 'rejected' };
  return verifyAdminPhysio(req, res, next);
}

export async function deleteAdminPhysio(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid physiotherapist id' });
    }

    const hasActiveBookings = await Booking.exists({
      physioId: id,
      $or: [
        { status: { $ne: 'completed' } },
        { paymentStatus: { $in: ['held', 'pending'] } },
      ],
    });
    if (hasActiveBookings) {
      return res
        .status(409)
        .json({ message: 'Cannot delete physiotherapist with active bookings' });
    }

    const physio = await Physiotherapist.findByIdAndDelete(id).lean();
    if (!physio) return res.status(404).json({ message: 'Physiotherapist not found' });

    await User.updateMany(
      { physioId: id },
      [
        {
          $set: {
            physioId: null,
            role: {
              $cond: [{ $eq: ['$role', 'physio'] }, 'user', '$role'],
            },
          },
        },
      ]
    );

    return res.json({ ok: true, deletedId: id });
  } catch (err) {
    next(err);
  }
}
