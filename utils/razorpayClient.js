import { createRequire } from 'node:module';
import Razorpay from 'razorpay';

const require = createRequire(import.meta.url);
const { validatePaymentVerification } = require('razorpay/dist/utils/razorpay-utils');

export function getRazorpayConfig() {
  const keyId = String(process.env.RAZORPAY_KEY_ID ?? '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET ?? '').trim();
  if (!keyId || !keySecret) {
    const err = new Error(
      'Razorpay keys are not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). Use the same dashboard key pair (test keys start with rzp_test_).'
    );
    err.statusCode = 500;
    throw err;
  }
  const amountPaise = Number(process.env.RAZORPAY_AMOUNT_PAISE) || 50000;
  return { keyId, keySecret, amountPaise };
}

/**
 * @param {string} orderId
 * @param {string} paymentId
 * @param {string} signature
 * @param {string} keySecret
 * @returns {{ orderId: string, paymentId: string }}
 */
export function assertValidRazorpayPaymentSignature(orderId, paymentId, signature, keySecret) {
  const oid = String(orderId ?? '').trim();
  const pid = String(paymentId ?? '').trim();
  const sig = String(signature ?? '').trim();
  if (!oid || !pid || !sig) {
    const err = new Error('Missing payment verification fields from checkout');
    err.statusCode = 400;
    throw err;
  }
  const ok = validatePaymentVerification({ order_id: oid, payment_id: pid }, sig, keySecret);
  if (!ok) {
    const err = new Error(
      'Invalid payment signature — check that RAZORPAY_KEY_SECRET matches the same Razorpay mode as RAZORPAY_KEY_ID (test secret for rzp_test_ keys).'
    );
    err.statusCode = 400;
    throw err;
  }
  return { orderId: oid, paymentId: pid };
}

/**
 * Confirms the payment exists and belongs to the order (helps diagnose test vs live key mixups).
 * @param {InstanceType<typeof Razorpay>} razorpay
 * @param {string} paymentId
 * @param {string} orderId
 */
export async function assertPaymentCapturedForOrder(razorpay, paymentId, orderId) {
  let payment;
  try {
    payment = await razorpay.payments.fetch(paymentId);
  } catch (e) {
    const err = new Error(
      `Could not load payment from Razorpay (${e?.error?.description || e?.message || 'request failed'}). Check API keys.`
    );
    err.statusCode = 400;
    throw err;
  }
  if (payment?.order_id && String(payment.order_id) !== String(orderId)) {
    const err = new Error('Payment does not belong to this order');
    err.statusCode = 400;
    throw err;
  }
  const st = payment?.status;
  if (st !== 'captured' && st !== 'authorized') {
    const err = new Error(
      `Razorpay payment status is "${st || 'unknown'}" (expected captured). In test mode complete the checkout with a success test method (e.g. card 4111 1111 1111 1111).`
    );
    err.statusCode = 400;
    throw err;
  }
}

export { Razorpay };
