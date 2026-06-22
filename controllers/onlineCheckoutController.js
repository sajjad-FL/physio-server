import crypto from 'crypto';
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
import { getDefaultBookingAmountRupeesSync } from '../utils/pricingConfig.js';
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
import { applyWalletCredit } from '../utils/walletCheckout.js';
import { deductWalletForBooking } from '../utils/walletLedger.js';

const PHYSIO_SLOT_CONFLICT_MSG =
  'This physiotherapist already has another booking in that time slot';
const SLOT_AT_PLATFORM_CAPACITY_MSG =
  'All available physiotherapists are already booked for this time slot';

function defaultBookingAmountRupees() {
  return getDefaultBookingAmountRupeesSync();
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

function publicApiOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function safeHostedTokenEq(stored, given) {
  const a = String(stored || '');
  const b = String(given || '');
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** After Razorpay verification + row lock (`status: completing`). */
async function finalizeLockedCheckoutSession(res, locked, verifiedOrderId, verifiedPaymentId, paymentIdTrim) {
  const userId = locked.userId;

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
    await OnlineCheckoutSession.updateOne({ _id: locked._id }, { $set: { status: 'cancelled' } });
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

  const grossAmountPaise =
    Number.isFinite(Number(locked.grossAmountPaise)) && Number(locked.grossAmountPaise) > 0
      ? Number(locked.grossAmountPaise)
      : Number(locked.amountPaise);
  const walletDiscountPaise = Math.max(0, Number(locked.walletDiscountPaise) || 0);
  const totalAmount = roundMoney2(grossAmountPaise / 100);
  const walletDiscount = roundMoney2(walletDiscountPaise / 100);
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
      walletDiscount,
      walletDeducted: false,
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
    await OnlineCheckoutSession.updateOne({ _id: locked._id }, { $set: { status: 'cancelled' } });
    if (e?.code === 11000) {
      return res.status(409).json({
        message:
          'Could not confirm this booking (conflict). Your payment has been refunded if capture succeeded.',
      });
    }
    throw e;
  }

  await deductWalletForBooking(booking, userId);
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

    const grossRupees = onlineCheckoutGrossRupees(selectedPhysio);
    const pricing = applyWalletCredit({
      user,
      grossRupees,
      useWalletCredit: req.body?.useWalletCredit === true,
    });

    const { keyId, keySecret, amountPaise: envFallback } = getRazorpayConfig();
    const payableAmountPaise =
      pricing.payablePaise > 0 ? pricing.payablePaise : envFallback;
    const grossAmountPaise = Math.round(pricing.grossRupees * 100);
    const walletDiscountPaise = Math.round(pricing.walletDeduction * 100);

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await razorpay.orders.create({
      amount: payableAmountPaise,
      currency: 'INR',
      receipt: `oc_${String(userId).slice(-8)}_${Date.now().toString(36)}`,
      payment_capture: 1,
    });

    const hostedToken = crypto.randomBytes(24).toString('hex');
    const session = await OnlineCheckoutSession.create({
      userId,
      razorpayOrderId: order.id,
      amountPaise: order.amount,
      grossAmountPaise,
      walletDiscountPaise,
      useWalletCredit: req.body?.useWalletCredit === true,
      hostedToken,
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

    const hostedPayUrl = `${publicApiOrigin(req)}/api/bookings/online-checkout/hosted/${session._id}?t=${encodeURIComponent(hostedToken)}`;

    return res.json({
      checkoutSessionId: session._id.toString(),
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId,
      hostedPayUrl,
      grossAmount: pricing.grossRupees,
      walletDiscount: pricing.walletDeduction,
      payableAmount: pricing.payableRupees,
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

    return finalizeLockedCheckoutSession(res, locked, verifiedOrderId, verifiedPaymentId, paymentIdTrim);
  } catch (err) {
    next(err);
  }
}

/** HTML checkout for Expo Go / browsers (`GET ?t=` hosted token). */
export async function renderHostedOnlineCheckoutPage(req, res, next) {
  try {
    const { sessionId } = req.params || {};
    const t = String(req.query?.t || '').trim();
    const nextUrl = typeof req.query?.next === 'string' ? req.query.next.trim() : '';

    if (!mongoose.isValidObjectId(String(sessionId || '')) || !t) {
      return res.status(400).type('text/plain').send('Invalid payment link.');
    }

    const session = await OnlineCheckoutSession.findOne({
      _id: sessionId,
      status: 'pending',
    }).lean();
    if (!session || !safeHostedTokenEq(session.hostedToken, t)) {
      return res.status(404).type('text/plain').send('This checkout link expired or is invalid.');
    }

    const { keyId } = getRazorpayConfig();
    const origin = publicApiOrigin(req);
    const cfg = {
      checkoutSessionId: String(session._id),
      hostedToken: t,
      orderId: session.razorpayOrderId,
      amount: session.amountPaise,
      currency: 'INR',
      keyId,
      completeUrl: `${origin}/api/bookings/online-checkout/complete-hosted`,
      nextUrl,
    };
    const prefill = { name: session.draft?.name || 'Patient' };

    const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pay · PhysiOkhom</title>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<style>
body{font-family:system-ui,sans-serif;background:#0f766e;color:#fff;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;text-align:center;}
.card{max-width:400px;background:#fff;color:#0f172a;border-radius:16px;padding:24px;}
h1{font-size:1.125rem;margin:0 0 8px;}
p{font-size:.875rem;color:#64748b;margin:0 0 16px;line-height:1.4;}
#error{color:#b91c1c;font-size:.875rem;margin-top:12px;display:none;}
</style></head><body><div class="card">
<h1>Online consultation</h1><p>Open Razorpay to complete payment securely.</p><div id="error"></div>
</div><script>
var C=${JSON.stringify(cfg)};
var PF=${JSON.stringify(prefill)};
function showErr(msg){
  var e=document.getElementById('error');
  e.style.display='block';
  e.textContent=msg||'Something went wrong';
}
window.onload=function(){
  try{
    var options={
      key:String(C.keyId||''),
      amount:Number(C.amount)||0,
      currency:String(C.currency||'INR'),
      name:'PhysiOkhom',
      description:'Online consultation',
      order_id:String(C.orderId||''),
      prefill:PF,
      theme:{color:'#0d9488'},
      handler:function(response){
        fetch(String(C.completeUrl||''),{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            checkoutSessionId:String(C.checkoutSessionId||''),
            hostedToken:String(C.hostedToken||''),
            razorpay_order_id:response.razorpay_order_id,
            razorpay_payment_id:response.razorpay_payment_id,
            razorpay_signature:response.razorpay_signature
          })
        }).then(function(r){return r.json().then(function(j){return {ok:r.ok,status:r.status,j:j};});})
        .then(function(x){
          if(!x.ok){showErr((x.j&&x.j.message)||'Payment confirmation failed');return;}
          var id=x.j&&x.j._id;
          var nx=String(C.nextUrl||'');
          if(nx){var sep=nx.indexOf('?')>=0?'&':'?';window.location.replace(nx+sep+'id='+encodeURIComponent(String(id)));return;}
          document.querySelector('.card').innerHTML='<h1>Paid ✓</h1><p>Return to the app.</p>';
        }).catch(function(){showErr('Network error confirming payment');});
      },
      modal:{ondismiss:function(){}}
    };
    var rzp=new Razorpay(options);
    rzp.on('payment.failed',function(resp){showErr(resp&&resp.error&&resp.error.description?resp.error.description:'Payment failed');});
    rzp.open();
  }catch(e){showErr(e.message||'Checkout error');}
};
</script></body></html>`;

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(html);
  } catch (err) {
    next(err);
  }
}

/** Hosted page completion — no JWT; `hostedToken` proves session ownership. */
export async function completeHostedOnlineCheckout(req, res, next) {
  try {
    const {
      checkoutSessionId,
      hostedToken,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (
      !checkoutSessionId ||
      !hostedToken ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
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
      status: 'pending',
      razorpayOrderId: verifiedOrderId,
    });
    if (!session || !safeHostedTokenEq(session.hostedToken, hostedToken)) {
      return res.status(400).json({ message: 'Invalid or expired checkout session' });
    }

    const locked = await OnlineCheckoutSession.findOneAndUpdate(
      {
        _id: session._id,
        hostedToken: String(hostedToken).trim(),
        status: 'pending',
        razorpayOrderId: verifiedOrderId,
      },
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

    return finalizeLockedCheckoutSession(res, locked, verifiedOrderId, verifiedPaymentId, paymentIdTrim);
  } catch (err) {
    next(err);
  }
}
