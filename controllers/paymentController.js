import Razorpay from 'razorpay';
import Booking from '../models/Booking.js';
import { releaseEscrowBooking } from '../utils/releaseEscrow.js';
import { sendSMS, sendWhatsApp } from '../utils/notifications.js';
import {
  bookingAmountRupees,
  computeMarketplaceSplit,
  creditPhysioWalletOnline,
} from '../utils/marketplacePayment.js';
import {
  getRazorpayConfig,
  assertValidRazorpayPaymentSignature,
  assertPaymentCapturedForOrder,
} from '../utils/razorpayClient.js';

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

    const { keyId, keySecret, amountPaise } = getRazorpayConfig();

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

    if (booking.payment?.status === 'paid') {
      return res.status(400).json({ message: 'Payment already recorded' });
    }

    const rupees = bookingAmountRupees(booking);
    const split = computeMarketplaceSplit(rupees > 0 ? rupees : amountPaise / 100);

    booking.paymentStatus = 'held';
    booking.razorpayOrderId = verifiedOrderId;
    booking.razorpayPaymentId = verifiedPaymentId;
    booking.heldAt = new Date();
    booking.paidAt = booking.paidAt || new Date();
    if (booking.physioId) {
      booking.sessionStatus = 'scheduled';
    }
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

    const userPhone = booking.userId?.phone;
    if (booking.physioId) {
      await sendSMS({
        to: userPhone,
        message:
          'Payment received and secured. Your physiotherapist has been assigned for your home visit.',
      });
      await sendWhatsApp({
        to: userPhone,
        message:
          'Payment is confirmed and secured. We will reach out with your appointment confirmation shortly.',
      });
    } else {
      await sendSMS({
        to: userPhone,
        message:
          'Payment received (held). We are assigning a physiotherapist to your booking — you will be notified when confirmed.',
      });
      await sendWhatsApp({
        to: userPhone,
        message:
          'Payment is secured. Our team will assign a physiotherapist and notify you shortly.',
      });
    }

    const responseBooking = await Booking.findById(bookingId)
      .populate('userId', 'name phone location coordinates')
      .populate('physioId', 'name specialization location phone')
      .lean();

    return res.json(responseBooking || booking);
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
