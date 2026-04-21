import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Payment from '../models/Payment.js';
import { recomputeBookingPaymentRollup } from '../utils/installmentRollup.js';
import {
  postOnlineInstallmentCredit,
  postOfflineInstallmentPair,
} from '../services/ledger.js';
import { sendSMS, sendWhatsApp } from '../utils/notifications.js';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

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
  return { keyId, keySecret };
}

/**
 * Outstanding on a booking = totalAmount - sum(verified + in-flight Payment rows).
 * In-flight = pending/paid/collected (not yet verified/rejected).
 */
async function computeOutstanding(booking) {
  const rows = await Payment.find({ bookingId: booking._id }).lean();
  const claimed = rows
    .filter((r) => ['pending', 'paid', 'collected', 'verified'].includes(r.status))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalAmount = Number(booking.totalAmount || booking.payment?.amount || 0);
  return roundMoney2(Math.max(0, totalAmount - claimed));
}

/**
 * Physio records a cash / UPI collection for a booking. Creates a Payment
 * row in `collected` status; admin must verify before it hits the ledger.
 */
export async function recordOfflineCollection(req, res, next) {
  try {
    const { id } = req.params;
    const physioId = req.physio?.id;
    const amount = roundMoney2(Number(req.body?.amount));
    const note = String(req.body?.note || '').trim().slice(0, 500);

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }
    if (!physioId) return res.status(403).json({ message: 'Forbidden' });
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.physioId?.toString() !== physioId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (booking.homePlanPaymentMode !== 'offline') {
      return res.status(400).json({ message: 'Booking is not an offline plan' });
    }
    if (booking.planStatus && booking.planStatus !== 'approved') {
      return res.status(400).json({ message: 'Patient must approve the plan before collection' });
    }

    const outstanding = await computeOutstanding(booking);
    if (outstanding <= 0) {
      return res.status(400).json({ message: 'This booking is already fully paid' });
    }
    if (amount > outstanding + 0.009) {
      return res
        .status(400)
        .json({ message: `Amount exceeds outstanding (Rs.${outstanding.toFixed(2)})` });
    }

    const payment = await Payment.create({
      bookingId: booking._id,
      physioId: booking.physioId,
      userId: booking.userId,
      amount,
      mode: 'offline',
      status: 'collected',
      collectedBy: physioId,
      collectedAt: new Date(),
      note,
    });

    return res.status(201).json({ payment: payment.toObject() });
  } catch (err) {
    next(err);
  }
}

/**
 * Admin verifies a previously-collected offline installment. Posts the
 * per-installment ledger pair and refreshes the booking rollup.
 */
export async function adminVerifyPayment(req, res, next) {
  try {
    const { paymentId } = req.params;
    if (!req.admin) return res.status(403).json({ message: 'Admin only' });
    if (!mongoose.isValidObjectId(paymentId)) {
      return res.status(400).json({ message: 'Invalid payment id' });
    }

    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });
    if (payment.mode !== 'offline') {
      return res.status(400).json({ message: 'Only offline installments need admin verification' });
    }
    if (payment.status === 'verified') {
      return res.json({ payment: payment.toObject() });
    }
    if (payment.status !== 'collected') {
      return res
        .status(400)
        .json({ message: 'Physio must mark this collection before it can be verified' });
    }

    const booking = await Booking.findById(payment.bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    payment.status = 'verified';
    payment.verifiedAt = new Date();
    payment.rejectReason = '';
    await payment.save();

    await postOfflineInstallmentPair(booking, payment);
    await recomputeBookingPaymentRollup(booking);

    return res.json({ payment: payment.toObject() });
  } catch (err) {
    next(err);
  }
}

/**
 * Admin rejects a collected offline installment (e.g. physio misreported).
 * Physio can record a fresh collection afterwards.
 */
export async function adminRejectPayment(req, res, next) {
  try {
    const { paymentId } = req.params;
    if (!req.admin) return res.status(403).json({ message: 'Admin only' });
    if (!mongoose.isValidObjectId(paymentId)) {
      return res.status(400).json({ message: 'Invalid payment id' });
    }
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ message: 'reason is required' });

    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });
    if (payment.mode !== 'offline') {
      return res.status(400).json({ message: 'Only offline installments can be rejected' });
    }
    if (payment.status === 'rejected') return res.json({ payment: payment.toObject() });
    if (payment.status !== 'collected') {
      return res
        .status(400)
        .json({ message: 'Only collected offline installments can be rejected' });
    }

    payment.status = 'rejected';
    payment.rejectReason = reason;
    await payment.save();

    return res.json({ payment: payment.toObject() });
  } catch (err) {
    next(err);
  }
}

/**
 * Patient creates a Razorpay order for one installment. Inserts a `pending`
 * Payment row; on success the client calls verifyInstallment below.
 */
export async function createInstallmentOrder(req, res, next) {
  try {
    const userId = req.user?.id;
    const bookingId = req.body?.bookingId;
    const amount = roundMoney2(Number(req.body?.amount));
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'amount must be a positive number' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (booking.userId.toString() !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (booking.serviceType === 'home' && booking.planStatus && booking.planStatus !== 'approved') {
      return res.status(400).json({ message: 'Home visit plan must be approved before payment' });
    }
    if (booking.serviceType === 'home' && booking.homePlanPaymentMode === 'offline') {
      return res.status(400).json({ message: 'This plan uses offline payment' });
    }

    const outstanding = await computeOutstanding(booking);
    if (outstanding <= 0) {
      return res.status(400).json({ message: 'This booking is already fully paid' });
    }
    if (amount > outstanding + 0.009) {
      return res
        .status(400)
        .json({ message: `Amount exceeds outstanding (Rs.${outstanding.toFixed(2)})` });
    }

    const { keyId, keySecret } = getRazorpayConfig();
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const amountPaise = Math.round(amount * 100);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: 'inst_' + String(booking._id).slice(-6) + '_' + Date.now().toString().slice(-6),
      payment_capture: 1,
    });

    const payment = await Payment.create({
      bookingId: booking._id,
      physioId: booking.physioId,
      userId: booking.userId,
      amount,
      mode: 'online',
      status: 'pending',
      razorpayOrderId: order.id,
    });

    return res.status(201).json({
      paymentId: payment._id,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Patient verifies a Razorpay payment against a pending Payment row.
 * Flips the row to `verified`, posts the per-installment credit, refreshes
 * the booking rollup.
 */
export async function verifyInstallmentOrder(req, res, next) {
  try {
    const userId = req.user?.id;
    const { paymentId, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!mongoose.isValidObjectId(paymentId)) {
      return res.status(400).json({ message: 'Invalid payment id' });
    }
    if (!razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: 'Missing payment details' });
    }

    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });
    if (payment.userId.toString() !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (payment.mode !== 'online') {
      return res.status(400).json({ message: 'Only online installments are verified this way' });
    }
    if (payment.status === 'verified') {
      return res.json({ payment: payment.toObject() });
    }
    if (payment.status !== 'pending' && payment.status !== 'paid') {
      return res.status(400).json({ message: 'Payment is not awaiting verification' });
    }
    if (!payment.razorpayOrderId) {
      return res.status(400).json({ message: 'Missing Razorpay order on payment' });
    }

    const { keySecret } = getRazorpayConfig();
    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(payment.razorpayOrderId + '|' + razorpay_payment_id)
      .digest('hex');
    if (expected !== razorpay_signature) {
      return res.status(400).json({ message: 'Invalid payment signature' });
    }

    const booking = await Booking.findById(payment.bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    payment.razorpayPaymentId = razorpay_payment_id;
    payment.status = 'verified';
    payment.verifiedAt = new Date();
    await payment.save();

    await postOnlineInstallmentCredit(booking, payment);
    await recomputeBookingPaymentRollup(booking);

    try {
      await booking.populate('userId', 'phone name');
      if (booking.userId?.phone) {
        const msg = `Installment of Rs.${payment.amount.toFixed(2)} received for your booking. Thank you!`;
        await sendSMS({ to: booking.userId.phone, message: msg });
        await sendWhatsApp({ to: booking.userId.phone, message: msg });
      }
    } catch (_notifyErr) {
      // non-fatal
    }

    return res.json({ payment: payment.toObject() });
  } catch (err) {
    next(err);
  }
}
