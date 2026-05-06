import mongoose from 'mongoose';
import OnlineCheckoutSession from '../models/OnlineCheckoutSession.js';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { sendSMS, sendWhatsApp } from '../utils/notifications.js';
import {
  computeMarketplaceSplit,
  creditPhysioWalletOnline,
  roundMoney2,
} from '../utils/marketplacePayment.js';
import { isPhysioBookable } from '../utils/physioVerification.js';
import {
  getBookablePhysioCount,
  countActivePrimaryBookingsForSlot,
} from '../utils/slotCapacity.js';
import { DAILY_SLOTS, todayYMDLocal, isSlotStartInPastForToday } from '../config/slots.js';
import {
  Razorpay,
  getRazorpayConfig,
  assertValidRazorpayPaymentSignature,
  assertPaymentCapturedForOrder,
} from '../utils/razorpayClient.js';

const PHYSIO_SLOT_CONFLICT_MSG =
  'This physiotherapist already has another booking in that time slot';
const SLOT_AT_PLATFORM_CAPACITY_MSG =
  'All available physiotherapists are already booked for this time slot';

function defaultBookingAmountRupees() {
  const n = Number(process.env.DEFAULT_BOOKING_AMOUNT_RUPEES);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/** Gross rupees for online checkout: physio fixed fee when set, else platform default. */
function onlineCheckoutGrossRupees(selectedPhysio) {
  const p = Number(selectedPhysio?.pricePerSession);
  if (Number.isFinite(p) && p > 0) return roundMoney2(p);
  return defaultBookingAmountRupees();
}

function isValidDateString(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(`${dateStr}T00:00:00.000Z`);
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

async function hasPhysioSlotConflict({ physioId, date, timeSlot }) {
  if (!physioId || !mongoose.isValidObjectId(String(physioId))) return false;
  const pid = new mongoose.Types.ObjectId(String(physioId));
  const conflict = await Booking.exists({
    physioId: pid,
    date,
    timeSlot,
  });
  return Boolean(conflict);
}

/**
 * Shared validation for starting or completing an online checkout (pay-first).
 * @returns {Promise<{ ok: false, status: number, message: string } | { ok: true, value: object }>}
 */
async function validateOnlineCheckoutDraft(userId, body) {
  const { name, location, issue, date, timeSlot, consentAccepted, physioId } = body || {};

  if (consentAccepted !== true) {
    return { ok: false, status: 400, message: 'You must accept consent before booking' };
  }
  if (!name?.trim() || !location?.trim() || !issue?.trim() || !date || !timeSlot) {
    return {
      ok: false,
      status: 400,
      message: 'name, location, issue, date, and timeSlot are required',
    };
  }
  if (!isValidDateString(date)) {
    return { ok: false, status: 400, message: 'date must be YYYY-MM-DD' };
  }
  const normalizedTimeSlot = normalizeTimeSlot(timeSlot);
  if (!DAILY_SLOTS.includes(normalizedTimeSlot)) {
    return { ok: false, status: 400, message: 'timeSlot is not available' };
  }

  const todayYmd = todayYMDLocal();
  if (date < todayYmd) {
    return { ok: false, status: 400, message: 'Date must be today or in the future' };
  }
  if (date === todayYmd && isSlotStartInPastForToday(normalizedTimeSlot)) {
    return { ok: false, status: 400, message: 'This time slot is no longer available' };
  }

  const platformCapacity = await getBookablePhysioCount();
  if (platformCapacity < 1) {
    return {
      ok: false,
      status: 503,
      message: 'No verified physiotherapists are available to take new bookings right now',
    };
  }
  const alreadyBooked = await countActivePrimaryBookingsForSlot(date, normalizedTimeSlot);
  if (alreadyBooked >= platformCapacity) {
    return { ok: false, status: 409, message: SLOT_AT_PLATFORM_CAPACITY_MSG };
  }

  if (!physioId) {
    return { ok: false, status: 400, message: 'physioId is required for online consultation' };
  }
  if (!mongoose.isValidObjectId(String(physioId))) {
    return { ok: false, status: 400, message: 'Invalid physiotherapist id' };
  }
  const selectedPhysio = await Physiotherapist.findById(physioId).lean();
  if (!selectedPhysio) {
    return { ok: false, status: 400, message: 'Physiotherapist not found' };
  }
  if (!isPhysioBookable(selectedPhysio)) {
    return {
      ok: false,
      status: 400,
      message: 'That physiotherapist is not approved or not available for new bookings.',
    };
  }
  const conflict = await hasPhysioSlotConflict({
    physioId: selectedPhysio._id,
    date,
    timeSlot: normalizedTimeSlot,
  });
  if (conflict) {
    return { ok: false, status: 409, message: PHYSIO_SLOT_CONFLICT_MSG };
  }

  const user = await User.findById(userId);
  if (!user || !user.isVerified) {
    return { ok: false, status: 401, message: 'Unauthorized' };
  }

  const coords = parseCoords(body);
  return {
    ok: true,
    value: {
      user,
      selectedPhysio,
      normalizedTimeSlot,
      date,
      name: name.trim(),
      location: location.trim(),
      issue: issue.trim(),
      coords,
    },
  };
}

async function tryRefundPayment(paymentId, amountPaise) {
  try {
    const { keyId, keySecret } = getRazorpayConfig();
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    await razorpay.payments.refund(paymentId, { amount: amountPaise });
  } catch (e) {
    console.error('[online-checkout] Razorpay refund failed', e?.message || e);
  }
}

export async function startOnlineCheckout(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const v = await validateOnlineCheckoutDraft(userId, {
      ...req.body,
      serviceType: 'online',
      physioId: req.body?.physioId,
    });
    if (!v.ok) {
      return res.status(v.status).json({ message: v.message });
    }

    const { name, location, issue, date, coords, selectedPhysio, normalizedTimeSlot, user } = v.value;

    const totalAmount = onlineCheckoutGrossRupees(selectedPhysio);
    const amountPaise = Math.round(totalAmount * 100);

    const { keyId, keySecret, amountPaise: envFallback } = getRazorpayConfig();
    const payableAmountPaise =
      Number.isFinite(amountPaise) && amountPaise > 0 ? amountPaise : envFallback;

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await razorpay.orders.create({
      amount: payableAmountPaise,
      currency: 'INR',
      receipt: `oc_${String(userId).slice(-8)}_${Date.now().toString(36)}`,
      payment_capture: 1,
    });

    const session = await OnlineCheckoutSession.create({
      userId,
      razorpayOrderId: order.id,
      amountPaise: order.amount,
      draft: {
        name,
        location,
        issue,
        date,
        timeSlot: normalizedTimeSlot,
        physioId: selectedPhysio._id,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
      },
      status: 'pending',
    });

    return res.json({
      checkoutSessionId: session._id.toString(),
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId,
      /** Patient (logged-in user) contact for Razorpay checkout — from DB, not client state. */
      prefill: {
        name: String(name || user?.name || '').trim(),
        phone: String(user?.phone ?? '').trim(),
        email: String(user?.email ?? '').trim(),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function completeOnlineCheckout(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const {
      checkoutSessionId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (!checkoutSessionId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: 'Missing checkout or payment details' });
    }
    if (!mongoose.isValidObjectId(String(checkoutSessionId))) {
      return res.status(400).json({ message: 'Invalid checkout session id' });
    }

    const paymentIdTrim = String(razorpay_payment_id ?? '').trim();
    const existingPaid = await Booking.findOne({ razorpayPaymentId: paymentIdTrim })
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone')
      .lean();
    if (existingPaid) {
      return res.json(existingPaid);
    }

    const { keyId, keySecret } = getRazorpayConfig();
    let verifiedOrderId;
    let verifiedPaymentId;
    try {
      ;({ orderId: verifiedOrderId, paymentId: verifiedPaymentId } = assertValidRazorpayPaymentSignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        keySecret,
      ));
    } catch (e) {
      return res.status(e.statusCode || 400).json({ message: e.message });
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    try {
      await assertPaymentCapturedForOrder(razorpay, verifiedPaymentId, verifiedOrderId);
    } catch (e) {
      return res.status(e.statusCode || 400).json({ message: e.message });
    }

    const session = await OnlineCheckoutSession.findOne({
      _id: checkoutSessionId,
      userId,
      status: 'pending',
      razorpayOrderId: verifiedOrderId,
    });
    if (!session) {
      return res.status(400).json({ message: 'Invalid or expired checkout session' });
    }

    const locked = await OnlineCheckoutSession.findOneAndUpdate(
      { _id: session._id, userId, status: 'pending', razorpayOrderId: verifiedOrderId },
      { $set: { status: 'completing' } },
      { new: true }
    );
    if (!locked) {
      const dup = await Booking.findOne({ razorpayPaymentId: paymentIdTrim })
        .populate('userId', 'name phone location coordinates')
        .populate('physioId', 'name specialization location phone')
        .lean();
      if (dup) return res.json(dup);
      return res.status(400).json({ message: 'Checkout session is no longer valid' });
    }

    const draft = locked.draft;
    const bodyForRevalidate = {
      name: draft.name,
      location: draft.location,
      issue: draft.issue,
      date: draft.date,
      timeSlot: draft.timeSlot,
      physioId: draft.physioId,
      lat: draft.lat,
      lng: draft.lng,
      consentAccepted: true,
    };
    const v = await validateOnlineCheckoutDraft(userId, bodyForRevalidate);
    if (!v.ok) {
      await tryRefundPayment(verifiedPaymentId, locked.amountPaise);
      await OnlineCheckoutSession.updateOne(
        { _id: locked._id },
        { $set: { status: 'cancelled' } }
      );
      return res.status(v.status).json({
        message: `${v.message} Your payment has been refunded if capture succeeded.`,
      });
    }

    const { selectedPhysio, normalizedTimeSlot, coords } = v.value;

    const userUpdate = {
      name: draft.name,
      location: draft.location,
    };
    if (coords) {
      userUpdate.coordinates = coords;
    }
    await User.findByIdAndUpdate(userId, userUpdate, { new: true });

    const totalAmount = roundMoney2(locked.amountPaise / 100);
    const split = computeMarketplaceSplit(totalAmount);

    let booking;
    try {
      booking = await Booking.create({
        userId,
        physioId: selectedPhysio._id,
        issue: draft.issue,
        date: draft.date,
        timeSlot: normalizedTimeSlot,
        status: 'assigned',
        paymentStatus: 'held',
        serviceType: 'online',
        sessions: 1,
        amountPaise: locked.amountPaise,
        totalAmount,
        consentAccepted: true,
        razorpayOrderId: verifiedOrderId,
        razorpayPaymentId: verifiedPaymentId,
        heldAt: new Date(),
        paidAt: new Date(),
        sessionStatus: 'scheduled',
        payment: {
          mode: 'online',
          status: 'paid',
          amount: split.amount,
          commission: split.commission,
          physioEarning: split.physioEarning,
        },
      });
    } catch (e) {
      await tryRefundPayment(verifiedPaymentId, locked.amountPaise);
      await OnlineCheckoutSession.updateOne(
        { _id: locked._id },
        { $set: { status: 'cancelled' } }
      );
      if (e?.code === 11000) {
        return res.status(409).json({
          message:
            'Could not confirm this booking (conflict). Your payment has been refunded if capture succeeded.',
        });
      }
      throw e;
    }

    await creditPhysioWalletOnline(booking);

    await OnlineCheckoutSession.updateOne({ _id: locked._id }, { $set: { status: 'completed' } });

    const user = await User.findById(userId).lean();
    const when = `${draft.date} ${normalizedTimeSlot}`;
    if (user?.phone) {
      await sendSMS({
        to: user.phone,
        message: `Payment received. Your online consultation with ${selectedPhysio.name || 'your physio'} is confirmed for ${when}.`,
      });
      await sendWhatsApp({
        to: user.phone,
        message: `Your online consultation is confirmed for ${when}. You can view details in your bookings.`,
      });
    }
    if (selectedPhysio.phone) {
      await sendSMS({
        to: selectedPhysio.phone,
        message: `New paid online consultation: ${when}. Open your dashboard to review.`,
      });
      await sendWhatsApp({
        to: selectedPhysio.phone,
        message: `A patient completed payment for an online consultation (${when}). Check your physio dashboard.`,
      });
    }

    const populated = await Booking.findById(booking._id)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone')
      .lean();

    return res.json(populated);
  } catch (err) {
    next(err);
  }
}
