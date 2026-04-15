import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { isPhysioPlatformApproved } from '../utils/physioVerification.js';
import { sendSMS, sendWhatsApp } from '../utils/notifications.js';
import { creditPhysioWalletOnline } from '../utils/marketplacePayment.js';

const PHYSIO_SLOT_CONFLICT_MSG =
  'You already have another booking in that time slot. Please ask admin to reassign this booking or reschedule one of them.';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 10));
  return { page, limit, skip: (page - 1) * limit };
}

export async function getMe(req, res, next) {
  try {
    const physio = await Physiotherapist.findById(req.physio.id).lean();
    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json({
      ...physio,
      platformApproved: isPhysioPlatformApproved(physio),
    });
  } catch (err) {
    next(err);
  }
}

export async function getPhysioBookingById(req, res, next) {
  try {
    const physioId = req.physio?.id;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
      .lean();

    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const assignedId = booking.physioId?._id
      ? booking.physioId._id.toString()
      : booking.physioId?.toString?.() || '';
    if (assignedId !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    return res.json(booking);
  } catch (err) {
    next(err);
  }
}

export async function listMyBookings(req, res, next) {
  try {
    const physioId = req.physio?.id;
    const { page, limit, skip } = readPagination(req.query);
    const query = { physioId };
    const [list, total] = await Promise.all([
      Booking.find(query)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
      .sort({ date: 1, timeSlot: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
      Booking.countDocuments(query),
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

export async function patchAvailability(req, res, next) {
  try {
    const { availability } = req.body || {};
    if (typeof availability !== 'boolean') {
      return res.status(400).json({ message: 'availability boolean is required' });
    }

    const physio = await Physiotherapist.findByIdAndUpdate(
      req.physio.id,
      { availability, isAvailable: availability },
      { new: true }
    ).lean();

    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

export async function respondToAssignment(req, res, next) {
  try {
    const physioId = req.physio?.id;
    const { id } = req.params;
    const action = String(req.body?.action || '').toLowerCase();

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }
    if (action !== 'accept' && action !== 'reject') {
      return res.status(400).json({ message: 'action must be accept or reject' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.physioId?.toString() !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (booking.status !== 'assigned') {
      return res.status(400).json({ message: 'This booking is not awaiting your response' });
    }

    const userIdForNotify = booking.userId;

    if (action === 'accept') {
      const conflict = await Booking.exists({
        _id: { $ne: booking._id },
        physioId,
        date: booking.date,
        timeSlot: booking.timeSlot,
      });
      if (conflict) {
        return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
      }

      booking.status = 'accepted';
      booking.sessionStatus = 'scheduled';
      await booking.save();

      if (booking.paymentStatus === 'held') {
        await creditPhysioWalletOnline(booking);
      }

      const user = await User.findById(userIdForNotify).select('phone name').lean();
      const userPhone = user?.phone;
      if (userPhone) {
        await sendSMS({
          to: userPhone,
          message:
            'Your physiotherapist has accepted your booking. Open your dashboard for visit details.',
        });
        await sendWhatsApp({
          to: userPhone,
          message:
            'Good news — your physiotherapist accepted the booking. Check the app for details.',
        });
      }
    } else {
      await Booking.findByIdAndUpdate(id, {
        physioId: null,
        status: 'pending',
        $unset: { sessionStatus: 1 },
      });

      const user = await User.findById(userIdForNotify).select('phone name').lean();
      const userPhone = user?.phone;
      if (userPhone) {
        await sendSMS({
          to: userPhone,
          message:
            'Your assigned physiotherapist was unavailable. We are re-assigning someone for your visit.',
        });
        await sendWhatsApp({
          to: userPhone,
          message:
            'We could not confirm the previous assignment. Our team will assign another physiotherapist shortly.',
        });
      }
    }

    const out = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
      .lean();

    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function patchLocation(req, res, next) {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: 'lat and lng are required numbers' });
    }

    const physio = await Physiotherapist.findByIdAndUpdate(
      req.physio.id,
      { coordinates: { lat, lng } },
      { new: true }
    ).lean();

    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

export async function completeSession(req, res, next) {
  try {
    const { bookingId } = req.params;
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.physioId?.toString() !== req.physio.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const isOffline =
      booking.payment?.mode === 'offline' ||
      (booking.serviceType === 'home' && booking.homePlanPaymentMode === 'offline');
    if (isOffline) {
      if (booking.payment?.status !== 'verified') {
        return res.status(400).json({
          message:
            'Offline payment must be verified by admin before the session can be completed',
        });
      }
    } else {
      if (booking.payment?.status !== 'paid') {
        return res.status(400).json({
          message: 'Patient payment must be confirmed before the session can be completed',
        });
      }
    }

    if (booking.paymentStatus !== 'held') {
      return res.status(400).json({ message: 'Payment must be secured before completing the session' });
    }

    const canComplete =
      booking.status === 'accepted' ||
      booking.status === 'scheduled' ||
      (booking.status === 'assigned' && booking.sessionStatus === 'scheduled');
    if (!canComplete) {
      return res.status(400).json({
        message: 'Accept the assignment before marking this session complete',
      });
    }

    booking.sessionStatus = 'completed';
    booking.status = 'completed';
    await booking.save();

    const out = await Booking.findById(bookingId)
      .populate('userId', 'name phone location')
      .populate('physioId', 'name specialization location')
      .lean();

    return res.json(out);
  } catch (err) {
    next(err);
  }
}
