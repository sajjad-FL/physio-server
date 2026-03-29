import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Physiotherapist from '../models/Physiotherapist.js';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 10));
  return { page, limit, skip: (page - 1) * limit };
}

export async function getMe(req, res, next) {
  try {
    const physio = await Physiotherapist.findById(req.physio.id).lean();
    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json(physio);
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
      .populate('physioId', 'name specialization location phone experience pricePerSession')
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
      .populate('physioId', 'name specialization location phone experience pricePerSession')
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
      return res.status(400).json({ message: 'Payment must be held in escrow to complete session' });
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
