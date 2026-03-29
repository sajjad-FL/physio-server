import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import Review from '../models/Review.js';
import { isPhysioBookable } from '../utils/physioVerification.js';
import { DAILY_SLOTS } from '../config/slots.js';
import { sendSMS, sendWhatsApp } from '../utils/notifications.js';
import {
  bookingAmountRupees,
  computeMarketplaceSplit,
  applyOfflineVerificationWallet,
} from '../utils/marketplacePayment.js';

const ALLOWED_STATUSES = ['pending', 'assigned', 'completed'];
const ALLOWED_SERVICE_TYPES = ['online', 'home'];

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 10));
  return { page, limit, skip: (page - 1) * limit };
}

function isValidDateString(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00.000Z');
  return !Number.isNaN(d.getTime());
}

function todayYMDLocal() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function normalizeTimeSlot(timeSlot) {
  return String(timeSlot || '').trim();
}

function parseCoords(body) {
  const lat = body?.lat ?? body?.coordinates?.lat;
  const lng = body?.lng ?? body?.coordinates?.lng;
  if (lat == null || lng == null) return null;
  const la = Number(lat);
  const ln = Number(lng);
  if (Number.isNaN(la) || Number.isNaN(ln)) return null;
  return { lat: la, lng: ln };
}

function parseSchedule(schedule) {
  if (!Array.isArray(schedule) || schedule.length === 0) return null;
  const normalized = [];
  for (const item of schedule) {
    const date = String(item?.date || '').trim();
    const time = String(item?.time || '').trim();
    if (!isValidDateString(date) || !time) return null;
    normalized.push({ date, time });
  }
  return normalized;
}

async function resolveSelectedPhysio(physioId) {
  if (!mongoose.isValidObjectId(physioId)) return null;
  const physio = await Physiotherapist.findById(physioId).lean();
  if (!physio) return null;
  if (!isPhysioBookable(physio)) return null;
  return physio;
}

export async function createBooking(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { name, location, issue, date, timeSlot, consentAccepted, physioId, serviceType } = req.body || {};

    if (consentAccepted !== true) {
      return res.status(400).json({ message: 'You must accept consent before booking' });
    }

    if (!name?.trim() || !location?.trim() || !issue?.trim() || !date || !timeSlot) {
      return res
        .status(400)
        .json({ message: 'name, location, issue, date, and timeSlot are required' });
    }

    if (!isValidDateString(date)) {
      return res.status(400).json({ message: 'date must be YYYY-MM-DD' });
    }

    const normalizedTimeSlot = normalizeTimeSlot(timeSlot);
    const normalizedServiceType = ALLOWED_SERVICE_TYPES.includes(serviceType)
      ? serviceType
      : 'online';
    const selectedPhysio = await resolveSelectedPhysio(physioId);
    if (!selectedPhysio) {
      return res.status(400).json({ message: 'A valid available physiotherapist must be selected' });
    }

    if (!DAILY_SLOTS.includes(normalizedTimeSlot)) {
      return res.status(400).json({ message: 'timeSlot is not available' });
    }

    const coords = parseCoords(req.body);
    const userUpdate = {
      name: name.trim(),
      location: location.trim(),
    };
    if (coords) {
      userUpdate.coordinates = coords;
    }

    const user = await User.findByIdAndUpdate(userId, userUpdate, { new: true });

    if (!user || !user.isVerified) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const totalAmount = Number(selectedPhysio.pricePerSession || 0);
    const split = computeMarketplaceSplit(totalAmount);

    let booking;
    try {
      booking = await Booking.create({
        userId,
        physioId: selectedPhysio._id,
        issue: issue.trim(),
        date,
        timeSlot: normalizedTimeSlot,
        status: 'assigned',
        paymentStatus: 'pending',
        serviceType: normalizedServiceType,
        sessions: 1,
        amountPaise: Math.round(totalAmount * 100),
        totalAmount,
        consentAccepted: true,
        payment: {
          mode: 'online',
          status: 'pending',
          amount: split.amount,
          commission: split.commission,
          physioEarning: split.physioEarning,
        },
      });
    } catch (e) {
      if (e?.code === 11000) {
        return res.status(409).json({ message: 'Selected slot is already booked' });
      }
      throw e;
    }

    const populated = await Booking.findById(booking._id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone')
      .lean();

    await sendSMS({
      to: user.phone,
      message: 'Booking request received for ' + date + ' at ' + normalizedTimeSlot,
    });
    await sendWhatsApp({
      to: user.phone,
      message: 'We will confirm your home physiotherapy session soon.',
    });

    return res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
}

export async function listBookings(req, res, next) {
  try {
    const { page, limit, skip } = readPagination(req.query);
    const [list, total] = await Promise.all([
      Booking.find()
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
      Booking.countDocuments(),
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

export async function listMyBookings(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { page, limit, skip } = readPagination(req.query);
    const [list, total] = await Promise.all([
      Booking.find({ userId })
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession')
      .sort({ date: -1, timeSlot: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
      Booking.countDocuments({ userId }),
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

export async function getAdminBookingById(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession')
      .lean();

    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    return res.json(booking);
  } catch (err) {
    next(err);
  }
}

export async function getBookingById(req, res, next) {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate(
        'physioId',
        'name specialization location phone experience pricePerSession avatar avgRating totalReviews'
      )
      .lean();

    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (userId && booking.userId?._id?.toString() !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const sessionDone = booking.sessionStatus === 'completed' && booking.status === 'completed';
    let reviewForBooking = null;
    if (userId && sessionDone && booking.physioId) {
      reviewForBooking = await Review.findOne({ bookingId: id }).select('rating comment createdAt').lean();
    }

    return res.json({
      ...booking,
      review: {
        canSubmit: Boolean(userId && sessionDone && booking.physioId && !reviewForBooking),
        submitted: reviewForBooking,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function updateBooking(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const { status, physioId } = req.body || {};
    const updates = {};

    if (status !== undefined) {
      if (!ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({
          message: `status must be one of: ${ALLOWED_STATUSES.join(', ')}`,
        });
      }
      updates.status = status;
    }

    if (physioId !== undefined) {
      if (physioId === null || physioId === '') {
        updates.physioId = null;
      } else {
        if (!mongoose.isValidObjectId(physioId)) {
          return res.status(400).json({ message: 'Invalid physiotherapist id' });
        }
        const physio = await Physiotherapist.findById(physioId).lean();
        if (!physio) {
          return res.status(400).json({ message: 'Physiotherapist not found' });
        }
        updates.physioId = physioId;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update (status or physioId)' });
    }

    const booking = await Booking.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    })
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone')
      .lean();

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    return res.json(booking);
  } catch (err) {
    next(err);
  }
}

export async function requestHomeBooking(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { name, location, issue, date, timeSlot, consentAccepted, physioId } = req.body || {};
    if (consentAccepted !== true) {
      return res.status(400).json({ message: 'You must accept consent before booking' });
    }
    if (!name?.trim() || !location?.trim() || !issue?.trim() || !date || !timeSlot) {
      return res
        .status(400)
        .json({ message: 'name, location, issue, date, and timeSlot are required' });
    }
    if (!isValidDateString(date)) {
      return res.status(400).json({ message: 'date must be YYYY-MM-DD' });
    }
    const normalizedTimeSlot = normalizeTimeSlot(timeSlot);
    if (!DAILY_SLOTS.includes(normalizedTimeSlot)) {
      return res.status(400).json({ message: 'timeSlot is not available' });
    }

    const selectedPhysio = await resolveSelectedPhysio(physioId);
    if (!selectedPhysio) {
      return res.status(400).json({ message: 'A valid available physiotherapist must be selected' });
    }

    const coords = parseCoords(req.body);
    const userUpdate = { name: name.trim(), location: location.trim() };
    if (coords) userUpdate.coordinates = coords;
    const user = await User.findByIdAndUpdate(userId, userUpdate, { new: true });
    if (!user || !user.isVerified) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    let booking;
    try {
      booking = await Booking.create({
        userId,
        physioId: selectedPhysio._id,
        issue: issue.trim(),
        date,
        timeSlot: normalizedTimeSlot,
        status: 'pending',
        paymentStatus: 'pending',
        serviceType: 'home',
        planStatus: 'requested',
        consentAccepted: true,
      });
    } catch (e) {
      if (e?.code === 11000) {
        return res.status(409).json({ message: 'Selected slot is already booked' });
      }
      throw e;
    }

    const out = await Booking.findById(booking._id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession')
      .lean();
    return res.status(201).json(out);
  } catch (err) {
    next(err);
  }
}

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export async function createHomePlan(req, res, next) {
  try {
    const { id } = req.params;
    const physioId = req.physio?.id;
    if (!physioId) return res.status(401).json({ message: 'Unauthorized' });
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.physioId?.toString() !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (booking.serviceType !== 'home') {
      return res.status(400).json({ message: 'Plan can be created only for home service' });
    }

    const sessions = Number(req.body?.sessions);
    const amountPerSession = Number(req.body?.amountPerSession);
    const discountPercent = Number(req.body?.discountPercent ?? 0);
    const paymentMode = req.body?.paymentMode === 'offline' ? 'offline' : 'online';
    const schedule = parseSchedule(req.body?.schedule);

    if (!Number.isInteger(sessions) || sessions < 1) {
      return res.status(400).json({ message: 'sessions must be an integer greater than 0' });
    }
    if (!schedule || schedule.length !== sessions) {
      return res.status(400).json({ message: 'schedule must match the number of sessions' });
    }
    if (!Number.isFinite(amountPerSession) || amountPerSession <= 0) {
      return res.status(400).json({ message: 'amountPerSession must be greater than 0' });
    }
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 15) {
      return res.status(400).json({ message: 'discountPercent must be between 0 and 15' });
    }

    const subtotal = sessions * amountPerSession;
    const totalAmount = roundMoney2(subtotal * (1 - discountPercent / 100));
    if (totalAmount <= 0) {
      return res.status(400).json({ message: 'total amount after discount must be greater than 0' });
    }

    const planSplit = computeMarketplaceSplit(totalAmount);

    booking.sessions = sessions;
    booking.schedule = schedule;
    booking.amountPerSession = amountPerSession;
    booking.discountPercent = discountPercent;
    booking.totalAmount = totalAmount;
    booking.amountPaise = Math.round(totalAmount * 100);
    booking.homePlanPaymentMode = paymentMode;
    booking.offlinePaymentVerified = false;
    booking.planStatus = 'proposed';
    booking.status = 'assigned';
    booking.payment = {
      mode: paymentMode,
      status: 'pending',
      amount: planSplit.amount,
      commission: planSplit.commission,
      physioEarning: planSplit.physioEarning,
    };
    await booking.save();

    const out = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

/**
 * Physio: cash / UPI collected from patient — does not finalize revenue (admin must verify).
 */
export async function collectOfflinePayment(req, res, next) {
  try {
    const { id } = req.params;
    const physioId = req.physio?.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }
    if (!physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.physioId?.toString() !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (booking.serviceType !== 'home') {
      return res.status(400).json({ message: 'Only home bookings support offline collection' });
    }
    if (booking.homePlanPaymentMode !== 'offline') {
      return res.status(400).json({ message: 'This booking is not offline payment mode' });
    }
    if (booking.planStatus !== 'approved') {
      return res.status(400).json({ message: 'Patient must approve the plan before collection' });
    }

    const ps = booking.payment?.status;
    if (ps === 'collected' || ps === 'verified') {
      const out = await Booking.findById(id)
        .populate('userId', 'name phone location coordinates')
        .populate('physioId', 'name specialization location phone experience pricePerSession')
        .lean();
      return res.json(out);
    }
    if (ps !== 'pending') {
      return res.status(400).json({ message: 'Payment is not awaiting collection' });
    }

    const p = booking.payment || {};
    booking.payment = {
      mode: 'offline',
      status: 'collected',
      amount: p.amount,
      commission: p.commission,
      physioEarning: p.physioEarning,
    };
    booking.offlinePaymentRejectReason = '';
    await booking.save();

    const out = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

/**
 * Admin: verify offline payment after physio marked collected — posts ledger + escrow held.
 */
export async function verifyOfflinePayment(req, res, next) {
  try {
    const { id } = req.params;
    if (!req.admin) {
      return res.status(403).json({ message: 'Admin only' });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.serviceType !== 'home') {
      return res.status(400).json({ message: 'Only home bookings support offline verification' });
    }
    if (booking.homePlanPaymentMode !== 'offline') {
      return res.status(400).json({ message: 'This booking is not offline payment mode' });
    }
    if (booking.planStatus !== 'approved') {
      return res.status(400).json({ message: 'Patient must approve the plan before payment can be verified' });
    }
    if (booking.payment?.status !== 'collected') {
      return res
        .status(400)
        .json({ message: 'Physiotherapist must mark payment as collected before admin verification' });
    }
    if (booking.offlinePaymentVerified) {
      return res.status(400).json({ message: 'Offline payment already verified' });
    }

    const rupees = bookingAmountRupees(booking);
    const split = computeMarketplaceSplit(rupees);

    booking.offlinePaymentVerified = true;
    booking.offlinePaymentRejectReason = '';
    booking.paymentStatus = 'held';
    booking.paidAt = booking.paidAt || new Date();
    booking.sessionStatus = booking.sessionStatus || 'scheduled';
    booking.payment = {
      mode: 'offline',
      status: 'verified',
      amount: split.amount,
      commission: split.commission,
      physioEarning: split.physioEarning,
    };
    await booking.save();

    await applyOfflineVerificationWallet(booking);

    const out = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

/**
 * Admin: reject collected offline payment — back to pending so physio can re-collect.
 */
export async function rejectOfflinePayment(req, res, next) {
  try {
    const { id } = req.params;
    if (!req.admin) {
      return res.status(403).json({ message: 'Admin only' });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!reason) {
      return res.status(400).json({ message: 'reason is required' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.serviceType !== 'home' || booking.homePlanPaymentMode !== 'offline') {
      return res.status(400).json({ message: 'Not an offline home booking' });
    }
    if (booking.payment?.status !== 'collected') {
      return res.status(400).json({ message: 'Only collected payments can be rejected' });
    }

    const p = booking.payment || {};
    booking.payment = {
      mode: 'offline',
      status: 'pending',
      amount: p.amount,
      commission: p.commission,
      physioEarning: p.physioEarning,
    };
    booking.offlinePaymentRejectReason = reason;
    await booking.save();

    const out = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function approveHomePlan(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.userId?.toString() !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (booking.serviceType !== 'home') {
      return res.status(400).json({ message: 'Only home bookings need plan approval' });
    }
    if (booking.planStatus !== 'proposed') {
      return res.status(400).json({ message: 'Plan is not ready for approval' });
    }

    booking.planStatus = 'approved';
    booking.status = 'assigned';
    await booking.save();

    const out = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function rescheduleBooking(req, res, next) {
  try {
    const { id } = req.params;
    const physioId = req.physio?.id;
    if (!physioId) return res.status(401).json({ message: 'Unauthorized' });
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const { date, timeSlot } = req.body || {};
    if (!date || !timeSlot) {
      return res.status(400).json({ message: 'date and timeSlot are required' });
    }
    if (!isValidDateString(date)) {
      return res.status(400).json({ message: 'date must be YYYY-MM-DD' });
    }
    const normalizedTimeSlot = normalizeTimeSlot(timeSlot);
    if (!DAILY_SLOTS.includes(normalizedTimeSlot)) {
      return res.status(400).json({ message: 'timeSlot is not available' });
    }

    const todayYmd = todayYMDLocal();
    if (date < todayYmd) {
      return res.status(400).json({ message: 'Date must be today or in the future' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.physioId?.toString() !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (booking.sessionStatus === 'completed') {
      return res.status(400).json({ message: 'Cannot reschedule a completed session' });
    }

    if (booking.date === date && booking.timeSlot === normalizedTimeSlot) {
      return res.status(400).json({ message: 'Already scheduled for this slot' });
    }

    const conflict = await Booking.findOne({
      _id: { $ne: booking._id },
      date,
      timeSlot: normalizedTimeSlot,
    }).lean();
    if (conflict) {
      return res.status(409).json({ message: 'That slot is already booked' });
    }

    booking.previousDate = booking.date;
    booking.previousTimeSlot = booking.timeSlot;
    booking.date = date;
    booking.timeSlot = normalizedTimeSlot;
    booking.rescheduled = true;
    booking.rescheduledAt = new Date();

    if (Array.isArray(booking.schedule) && booking.schedule.length > 0) {
      booking.schedule[0].date = date;
      booking.schedule[0].time = normalizedTimeSlot;
    }

    try {
      await booking.save();
    } catch (e) {
      if (e?.code === 11000) {
        return res.status(409).json({ message: 'That slot is already booked' });
      }
      throw e;
    }

    const out = await Booking.findById(id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}
