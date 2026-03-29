import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import Booking from '../models/Booking.js';
import { assignPhysioForBooking } from '../utils/assignPhysio.js';
import { releaseEscrowBooking } from '../utils/releaseEscrow.js';
import { sendSMS, sendWhatsApp } from '../utils/notifications.js';
import {
  bookingAmountRupees,
  computeMarketplaceSplit,
  creditPhysioWalletOnline,
} from '../utils/marketplacePayment.js';

function getRazorpayConfig() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    const err = new Error(
      'Razorpay keys are not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)'
    );
    err.statusCode = 500;
    throw err;
  }

  const amountPaise = Number(process.env.RAZORPAY_AMOUNT_PAISE) || 50000;

  return { keyId, keySecret, amountPaise };
}

export async function createOrder(req, res, next) {
  try {
    const userId = req.user?.id;
    const { bookingId } = req.body || {};

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!bookingId) return res.status(400).json({ message: 'bookingId is required' });

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.userId.toString() !== userId) return res.status(403).json({ message: 'Forbidden' });

    if (booking.paymentStatus === 'held' || booking.paymentStatus === 'released') {
      return res.status(400).json({ message: 'Booking payment is already settled' });
    }
    if (booking.serviceType === 'home' && booking.planStatus !== 'approved') {
      return res.status(400).json({ message: 'Home visit plan must be approved before payment' });
    }
    if (booking.serviceType === 'home' && booking.homePlanPaymentMode === 'offline') {
      return res.status(400).json({ message: 'This plan uses offline payment' });
    }

    const { keyId, keySecret, amountPaise } = getRazorpayConfig();
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const payableAmountPaise =
      Number.isFinite(Number(booking.amountPaise)) && Number(booking.amountPaise) > 0
        ? Number(booking.amountPaise)
        : amountPaise;

    const order = await razorpay.orders.create({
      amount: payableAmountPaise,
      currency: 'INR',
      receipt: 'rcpt_' + bookingId.toString().slice(-6),
      payment_capture: 1,
    });

    booking.razorpayOrderId = order.id;
    booking.amountPaise = order.amount;
    await booking.save();

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId,
    });
  } catch (err) {
    next(err);
  }
}

/** Same as verify — spec name for “hold after capture” */
export async function holdPayment(req, res, next) {
  return verifyPayment(req, res, next);
}

export async function verifyPayment(req, res, next) {
  try {
    const userId = req.user?.id;
    const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body || {};

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!bookingId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: 'Missing payment details' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.userId.toString() !== userId) return res.status(403).json({ message: 'Forbidden' });

    const { keySecret, amountPaise } = getRazorpayConfig();

    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({ message: 'Invalid payment signature' });
    }

    if (booking.payment?.status === 'paid') {
      return res.status(400).json({ message: 'Payment already recorded' });
    }

    const rupees = bookingAmountRupees(booking);
    const split = computeMarketplaceSplit(rupees > 0 ? rupees : amountPaise / 100);

    booking.paymentStatus = 'held';
    booking.razorpayOrderId = razorpay_order_id;
    booking.razorpayPaymentId = razorpay_payment_id;
    booking.heldAt = new Date();
    booking.paidAt = booking.paidAt || new Date();
    booking.sessionStatus = 'scheduled';
    booking.amountPaise = booking.amountPaise || amountPaise;
    booking.payment = {
      mode: 'online',
      status: 'paid',
      amount: split.amount,
      commission: split.commission,
      physioEarning: split.physioEarning,
    };
    await booking.save();

    await creditPhysioWalletOnline(booking);

    await booking.populate('userId', 'phone location coordinates name');

    const userCoords = booking.userId?.coordinates;
    const userLoc = booking.userId?.location;

    let updated = booking;
    if (booking.serviceType === 'home' && !booking.physioId) {
      updated = await assignPhysioForBooking(booking, userCoords, userLoc);
    }

    const userPhone = booking.userId?.phone;
    if (updated?.status === 'assigned' && updated?.physioId) {
      await sendSMS({
        to: userPhone,
        message:
          'Payment received (held in escrow). Your physiotherapist has been assigned for your home visit.',
      });
      await sendWhatsApp({
        to: userPhone,
        message:
          'Payment is confirmed and held. We will reach out with your appointment confirmation shortly.',
      });
    } else {
      await sendSMS({
        to: userPhone,
        message:
          'Payment received (held). We are confirming an available physiotherapist. You will be contacted soon.',
      });
    }

    const responseBooking = await Booking.findById(bookingId)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone')
      .lean();

    return res.json(responseBooking || updated || booking);
  } catch (err) {
    next(err);
  }
}

export async function releasePayment(req, res, next) {
  try {
    const { bookingId } = req.body || {};
    if (!bookingId) return res.status(400).json({ message: 'bookingId is required' });

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    try {
      await releaseEscrowBooking(booking, { requireNotesAndSession: true });
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ message: e.message || 'Release failed' });
    }

    const out = await Booking.findById(bookingId)
      .populate('userId', 'name phone location')
      .populate('physioId', 'name specialization location')
      .lean();

    return res.json(out);
  } catch (err) {
    next(err);
  }
}
