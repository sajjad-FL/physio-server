import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import Review from '../models/Review.js';
import Payment from '../models/Payment.js';
import { DAILY_SLOTS, todayYMDLocal, isSlotStartInPastForToday } from '../config/slots.js';
import { sendSMS, sendWhatsApp } from '../utils/notifications.js';
import {
  bookingAmountRupees,
  computeMarketplaceSplit,
  applyOfflineVerificationWallet,
} from '../utils/marketplacePayment.js';
import { isPhysioBookable } from '../utils/physioVerification.js';
import {
  getBookablePhysioCount,
  countActivePrimaryBookingsForSlot,
} from '../utils/slotCapacity.js';
import { deriveBookingPaymentSummary } from '../utils/installmentRollup.js';

async function attachPaymentsAndSummary(booking) {
  if (!booking?._id) return { payments: [], paymentSummary: null };
  const payments = await Payment.find({ bookingId: booking._id })
    .sort({ createdAt: -1 })
    .lean();
  return {
    payments,
    paymentSummary: deriveBookingPaymentSummary(booking, payments),
  };
}

const ALLOWED_STATUSES = ['pending', 'assigned', 'accepted', 'scheduled', 'completed'];
const PHYSIO_SLOT_CONFLICT_MSG =
  'This physiotherapist already has another booking in that time slot';
const SLOT_AT_PLATFORM_CAPACITY_MSG =
  'All available physiotherapists are already booked for this time slot';

function defaultBookingAmountRupees() {
  const n = Number(process.env.DEFAULT_BOOKING_AMOUNT_RUPEES);
  return Number.isFinite(n) && n > 0 ? n : 500;
}
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

function toObjectIdOrNull(v) {
  if (!v) return null;
  if (!mongoose.isValidObjectId(String(v))) return null;
  return new mongoose.Types.ObjectId(String(v));
}

async function hasPhysioSlotConflict({ bookingId, physioId, date, timeSlot }) {
  const pid = toObjectIdOrNull(physioId);
  if (!pid) return false;
  const conflict = await Booking.exists({
    _id: { $ne: bookingId },
    physioId: pid,
    date,
    timeSlot,
  });
  return Boolean(conflict);
}

/**
 * Patient creates a booking without choosing a physio — admin assigns later.
 * Any `physioId` on the body is ignored (legacy clients may still send it).
 */
export async function createBooking(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (req.body && req.body.physioId !== undefined) {
      delete req.body.physioId;
    }

    const { name, location, issue, date, timeSlot, consentAccepted, serviceType } = req.body || {};

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
      : 'home';
    if (!DAILY_SLOTS.includes(normalizedTimeSlot)) {
      return res.status(400).json({ message: 'timeSlot is not available' });
    }

    const todayYmd = todayYMDLocal();
    if (date < todayYmd) {
      return res.status(400).json({ message: 'Date must be today or in the future' });
    }
    if (date === todayYmd && isSlotStartInPastForToday(normalizedTimeSlot)) {
      return res.status(400).json({ message: 'This time slot is no longer available' });
    }

    const platformCapacity = await getBookablePhysioCount();
    if (platformCapacity < 1) {
      return res.status(503).json({
        message: 'No verified physiotherapists are available to take new bookings right now',
      });
    }
    const alreadyBooked = await countActivePrimaryBookingsForSlot(date, normalizedTimeSlot);
    if (alreadyBooked >= platformCapacity) {
      return res.status(409).json({ message: SLOT_AT_PLATFORM_CAPACITY_MSG });
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

    const totalAmount = defaultBookingAmountRupees();
    const split = computeMarketplaceSplit(totalAmount);

    let booking;
    try {
      booking = await Booking.create({
        userId,
        physioId: null,
        issue: issue.trim(),
        date,
        timeSlot: normalizedTimeSlot,
        status: 'pending',
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
        return res.status(409).json({
          message:
            'Could not save this booking (database conflict). Restart the API so booking indexes update, or run from server/: npm run migrate:booking-slot-index',
        });
      }
      throw e;
    }

    const populated = await Booking.findById(booking._id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone')
      .lean();

    await sendSMS({
      to: user.phone,
      message:
        'Booking request received for ' +
        date +
        ' at ' +
        normalizedTimeSlot +
        '. We are assigning a physiotherapist.',
    });
    await sendWhatsApp({
      to: user.phone,
      message: 'Thanks — we received your booking. Our team will assign a physiotherapist shortly.',
    });

    return res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
}

const ADMIN_LIST_STATUSES = ['pending', 'assigned', 'accepted', 'scheduled', 'completed'];
const ADMIN_PAYMENT_STATUSES = ['pending', 'held', 'released', 'refunded'];

function readAdminBookingsPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query?.limit) || 25));
  return { page, limit, skip: (page - 1) * limit };
}

function buildAdminBookingListFilter(query) {
  const parts = [];
  const { status, paymentStatus, assignment, serviceType, sessionStatus } = query || {};

  if (typeof status === 'string' && ADMIN_LIST_STATUSES.includes(status)) {
    parts.push({ status });
  }
  if (typeof paymentStatus === 'string' && ADMIN_PAYMENT_STATUSES.includes(paymentStatus)) {
    parts.push({ paymentStatus });
  }
  if (assignment === 'unassigned') {
    parts.push({ $or: [{ physioId: null }, { physioId: { $exists: false } }] });
  } else if (assignment === 'assigned') {
    parts.push({ physioId: { $ne: null } });
  }
  if (typeof serviceType === 'string' && ALLOWED_SERVICE_TYPES.includes(serviceType)) {
    parts.push({ serviceType });
  }
  if (sessionStatus === 'none' || sessionStatus === 'empty') {
    parts.push({ $or: [{ sessionStatus: null }, { sessionStatus: { $exists: false } }] });
  } else if (typeof sessionStatus === 'string' && ['scheduled', 'completed'].includes(sessionStatus)) {
    parts.push({ sessionStatus });
  }

  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

export async function listBookings(req, res, next) {
  try {
    const { page, limit, skip } = readAdminBookingsPagination(req.query);
    const mongoFilter = buildAdminBookingListFilter(req.query);

    const [list, total] = await Promise.all([
      Booking.find(mongoFilter)
        .populate('userId', 'name phone location coordinates')
        .populate('physioId', 'name specialization location phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Booking.countDocuments(mongoFilter),
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
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
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
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
      .lean();

    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const { payments, paymentSummary } = await attachPaymentsAndSummary(booking);
    return res.json({ ...booking, payments, paymentSummary });
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
        'name specialization location phone experience pricePerSession pricePerSessionMax avatar avgRating totalReviews'
      )
      .lean();

    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (userId && booking.userId?._id?.toString() !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const sessionDone = booking.sessionStatus === 'completed' && booking.status === 'completed';
    let reviewForBooking = null;
    let sessionReviews = [];
    if (userId && booking.physioId) {
      const rows = await Review.find({ bookingId: id, userId })
        .select('sessionId rating comment createdAt')
        .lean();
      reviewForBooking = rows.find((r) => r.sessionId == null) || null;
      sessionReviews = rows
        .filter((r) => r.sessionId != null)
        .map((r) => ({
          sessionId: String(r.sessionId),
          rating: r.rating,
          comment: r.comment || '',
          createdAt: r.createdAt,
        }));
    }

    const { payments, paymentSummary } = await attachPaymentsAndSummary(booking);

    return res.json({
      ...booking,
      review: {
        canSubmit: Boolean(userId && sessionDone && booking.physioId && !reviewForBooking),
        submitted: reviewForBooking,
      },
      sessionReviews,
      payments,
      paymentSummary,
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

    const prev = await Booking.findById(id).lean();
    if (!prev) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const { status, physioId, amountPerSession: amountPerSessionRaw } = req.body || {};
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
        if (!isPhysioBookable(physio)) {
          return res.status(400).json({
            message: 'That physiotherapist is not approved or not available for new bookings.',
          });
        }
        updates.physioId = physioId;
      }
    }

    if (updates.physioId) {
      const conflict = await hasPhysioSlotConflict({
        bookingId: id,
        physioId: updates.physioId,
        date: prev.date,
        timeSlot: prev.timeSlot,
      });
      if (conflict) {
        return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
      }
    }

    /**
     * Admin may set (or revise) the per-session price when assigning a physio.
     * This recomputes totalAmount, amountPaise and the marketplace commission split
     * so downstream Razorpay orders and wallet credits reflect the admin-set price.
     * Multi-session home plans are priced separately via createHomePlan and their
     * discount is preserved here if already present.
     */
    if (amountPerSessionRaw !== undefined && amountPerSessionRaw !== null && amountPerSessionRaw !== '') {
      const amountPerSession = Number(amountPerSessionRaw);
      if (!Number.isFinite(amountPerSession) || amountPerSession <= 0) {
        return res.status(400).json({ message: 'amountPerSession must be a positive number' });
      }
      if (prev.paymentStatus === 'held' || prev.paymentStatus === 'refunded') {
        return res.status(409).json({
          message:
            'Cannot change the session price after payment is held or refunded. Refund and rebook if needed.',
        });
      }
      const sessionsCount = Math.max(1, Number(prev.sessions) || 1);
      const discountPercent = Number(prev.discountPercent) > 0 ? Number(prev.discountPercent) : 0;
      const subtotal = amountPerSession * sessionsCount;
      const totalAmount = Math.round((subtotal * (1 - discountPercent / 100) + Number.EPSILON) * 100) / 100;
      const split = computeMarketplaceSplit(totalAmount);

      updates.amountPerSession = amountPerSession;
      updates.totalAmount = totalAmount;
      updates.amountPaise = Math.round(totalAmount * 100);
      updates['payment.amount'] = split.amount;
      updates['payment.commission'] = split.commission;
      updates['payment.physioEarning'] = split.physioEarning;
    }

    if (Object.keys(updates).length === 0) {
      return res
        .status(400)
        .json({ message: 'No valid fields to update (status, physioId, or amountPerSession)' });
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

    const nextPid =
      booking.physioId && booking.physioId._id
        ? booking.physioId._id.toString()
        : booking.physioId
          ? booking.physioId.toString()
          : '';
    const prevPid = prev.physioId ? prev.physioId.toString() : '';
    const physioNewlyAssigned = nextPid && nextPid !== prevPid;

    if (physioNewlyAssigned && booking.status === 'assigned' && nextPid) {
      const physioDoc = await Physiotherapist.findById(nextPid).select('phone name').lean();
      const phone = physioDoc?.phone;
      if (phone) {
        const when = `${booking.date} ${booking.timeSlot}`;
        await sendSMS({
          to: phone,
          message: `New booking assigned: ${when}. Open your dashboard to accept or reject.`,
        });
        await sendWhatsApp({
          to: phone,
          message: `You have a new patient booking (${when}). Please accept or reject in your physio dashboard.`,
        });
      }
    }

    return res.json(booking);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
    }
    next(err);
  }
}

export async function requestHomeBooking(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { name, location, issue, date, timeSlot, consentAccepted } = req.body || {};
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

    const todayYmdHome = todayYMDLocal();
    if (date < todayYmdHome) {
      return res.status(400).json({ message: 'Date must be today or in the future' });
    }
    if (date === todayYmdHome && isSlotStartInPastForToday(normalizedTimeSlot)) {
      return res.status(400).json({ message: 'This time slot is no longer available' });
    }

    const platformCapacityHome = await getBookablePhysioCount();
    if (platformCapacityHome < 1) {
      return res.status(503).json({
        message: 'No verified physiotherapists are available to take new bookings right now',
      });
    }
    const alreadyBookedHome = await countActivePrimaryBookingsForSlot(date, normalizedTimeSlot);
    if (alreadyBookedHome >= platformCapacityHome) {
      return res.status(409).json({ message: SLOT_AT_PLATFORM_CAPACITY_MSG });
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
        physioId: null,
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
        return res.status(409).json({
          message:
            'Could not save this booking (database conflict). Restart the API so booking indexes update, or run from server/: npm run migrate:booking-slot-index',
        });
      }
      throw e;
    }

    const out = await Booking.findById(booking._id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
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

    const physioRate = await Physiotherapist.findById(booking.physioId)
      .select('pricePerSession pricePerSessionMax')
      .lean();
    const rateLo = Number(physioRate?.pricePerSession);
    const rateHi = physioRate?.pricePerSessionMax != null ? Number(physioRate.pricePerSessionMax) : NaN;
    if (Number.isFinite(rateLo) && Number.isFinite(rateHi) && rateHi > rateLo) {
      if (amountPerSession < rateLo || amountPerSession > rateHi) {
        return res.status(400).json({
          message: `Per-session amount must be between ₹${rateLo} and ₹${rateHi} for this physiotherapist`,
        });
      }
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
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
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
        .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
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
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
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
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
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
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
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
      .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function rescheduleBooking(req, res, next) {
  try {
    const { id } = req.params;
    const isAdmin = Boolean(req.admin);
    const physioId = req.physio?.id;
    if (!isAdmin && !physioId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const { date, timeSlot, sessionId: rawSessionId } = req.body || {};
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
    if (date === todayYmd && isSlotStartInPastForToday(normalizedTimeSlot)) {
      return res.status(400).json({ message: 'This time slot is no longer available' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    if (!isAdmin) {
      if (booking.physioId?.toString() !== physioId) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    if (booking.sessionStatus === 'completed') {
      return res.status(400).json({ message: 'Cannot reschedule a completed session' });
    }

    const hasSchedule = Array.isArray(booking.schedule) && booking.schedule.length > 0;
    let scheduleIndex = 0;
    let sub = null;

    if (hasSchedule) {
      if (rawSessionId && mongoose.isValidObjectId(rawSessionId) && String(rawSessionId) !== String(booking._id)) {
        const idx = booking.schedule.findIndex((s) => s._id && String(s._id) === String(rawSessionId));
        if (idx < 0) {
          return res.status(404).json({ message: 'Session not found' });
        }
        scheduleIndex = idx;
        sub = booking.schedule[idx];
      } else {
        scheduleIndex = 0;
        sub = booking.schedule[0];
      }
    }

    const oldDate = hasSchedule && sub ? sub.date : booking.date;
    const oldTime = hasSchedule && sub ? sub.time : booking.timeSlot;

    if (oldDate === date && oldTime === normalizedTimeSlot) {
      return res.status(400).json({ message: 'Already scheduled for this slot' });
    }

    const updatesPrimarySlot = !hasSchedule || scheduleIndex === 0;
    if (updatesPrimarySlot) {
      const conflict = await hasPhysioSlotConflict({
        bookingId: booking._id,
        physioId: booking.physioId,
        date,
        timeSlot: normalizedTimeSlot,
      });
      if (conflict) {
        return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
      }
    }

    booking.rescheduled = true;
    booking.rescheduledAt = new Date();

    if (updatesPrimarySlot) {
      booking.previousDate = booking.date;
      booking.previousTimeSlot = booking.timeSlot;
      booking.date = date;
      booking.timeSlot = normalizedTimeSlot;
    }

    if (hasSchedule && sub) {
      sub.date = date;
      sub.time = normalizedTimeSlot;
    }

    try {
      await booking.save();
    } catch (e) {
      if (e?.code === 11000) {
        return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
      }
      throw e;
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

async function fetchBookingPopulated(bookingId) {
  return Booking.findById(bookingId)
    .populate('userId', 'name phone location coordinates')
    .populate('physioId', 'name specialization location phone experience pricePerSession pricePerSessionMax')
    .lean();
}

function ensureAdmin(req, res) {
  if (!req.admin) {
    res.status(403).json({ message: 'Admin only' });
    return false;
  }
  return true;
}

export async function addAdminBookingSession(req, res, next) {
  try {
    const { id } = req.params;
    if (!ensureAdmin(req, res)) return;
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
    if (date === todayYmd && isSlotStartInPastForToday(normalizedTimeSlot)) {
      return res.status(400).json({ message: 'This time slot is no longer available' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.sessionStatus === 'completed' || booking.status === 'completed') {
      return res.status(400).json({ message: 'Cannot modify sessions for a completed booking' });
    }

    const scheduleBase = Array.isArray(booking.schedule) && booking.schedule.length > 0
      ? booking.schedule
      : [{ date: booking.date, time: booking.timeSlot }];

    const duplicate = scheduleBase.some((s) => String(s.date) === String(date) && String(s.time) === normalizedTimeSlot);
    if (duplicate) {
      return res.status(400).json({ message: 'That session already exists in this booking schedule' });
    }

    const conflict = await hasPhysioSlotConflict({
      bookingId: booking._id,
      physioId: booking.physioId,
      date,
      timeSlot: normalizedTimeSlot,
    });
    if (conflict) {
      return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
    }

    booking.schedule = [...scheduleBase, { date, time: normalizedTimeSlot }];
    booking.sessions = booking.schedule.length;
    await booking.save();

    const out = await fetchBookingPopulated(id);
    return res.json(out);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
    }
    next(err);
  }
}

export async function deleteAdminBookingSession(req, res, next) {
  try {
    const { id, sessionId } = req.params;
    if (!ensureAdmin(req, res)) return;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }
    if (!sessionId || !mongoose.isValidObjectId(sessionId)) {
      return res.status(400).json({ message: 'Invalid session id' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.sessionStatus === 'completed' || booking.status === 'completed') {
      return res.status(400).json({ message: 'Cannot modify sessions for a completed booking' });
    }

    const scheduleBase = Array.isArray(booking.schedule) && booking.schedule.length > 0
      ? booking.schedule
      : [{ _id: booking._id, date: booking.date, time: booking.timeSlot }];

    const idx = scheduleBase.findIndex((s) => s?._id && String(s._id) === String(sessionId));
    if (idx < 0) {
      return res.status(404).json({ message: 'Session not found' });
    }

    // Removing the last session row collapses to primary-only (empty schedule array).
    if (scheduleBase.length <= 1) {
      const only = scheduleBase[idx];
      const newDate = String(only.date || '').trim();
      const newTimeSlot = normalizeTimeSlot(only.time);
      if (!isValidDateString(newDate) || !DAILY_SLOTS.includes(newTimeSlot)) {
        return res.status(400).json({ message: 'Invalid session data' });
      }
      const oldPrimary = { date: booking.date, timeSlot: booking.timeSlot };
      if (oldPrimary.date !== newDate || oldPrimary.timeSlot !== newTimeSlot) {
        const conflict = await hasPhysioSlotConflict({
          bookingId: booking._id,
          physioId: booking.physioId,
          date: newDate,
          timeSlot: newTimeSlot,
        });
        if (conflict) {
          return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
        }
        booking.previousDate = booking.date;
        booking.previousTimeSlot = booking.timeSlot;
        booking.rescheduled = true;
        booking.rescheduledAt = new Date();
      }
      booking.date = newDate;
      booking.timeSlot = newTimeSlot;
      booking.schedule = [];
      booking.sessions = 1;
      await booking.save();
      const out = await fetchBookingPopulated(id);
      return res.json(out);
    }

    const oldPrimary = { date: booking.date, timeSlot: booking.timeSlot };
    const nextSchedule = scheduleBase.filter((_, i) => i !== idx);
    const newPrimary = nextSchedule[0];

    if (
      oldPrimary.date !== newPrimary.date ||
      oldPrimary.timeSlot !== newPrimary.time
    ) {
      const conflict = await hasPhysioSlotConflict({
        bookingId: booking._id,
        physioId: booking.physioId,
        date: newPrimary.date,
        timeSlot: newPrimary.time,
      });
      if (conflict) {
        return res.status(409).json({
          message: 'Cannot delete this session because the new primary slot conflicts for this physiotherapist',
        });
      }
      booking.previousDate = booking.date;
      booking.previousTimeSlot = booking.timeSlot;
      booking.rescheduled = true;
      booking.rescheduledAt = new Date();
    }

    booking.schedule = nextSchedule;
    booking.sessions = nextSchedule.length;
    booking.date = newPrimary.date;
    booking.timeSlot = newPrimary.time;

    await booking.save();

    const out = await fetchBookingPopulated(id);
    return res.json(out);
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: PHYSIO_SLOT_CONFLICT_MSG });
    }
    next(err);
  }
}
