import {
  getAllowedPlanSessionCountsSync,
  getHomePlanMaxDiscountPercentSync,
  getPlatformCommissionPerSessionSync,
} from './pricingConfig.js';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Apply home plan pricing to a booking document (not saved).
 * @param {import('mongoose').Document} booking
 * @param {{ sessions: number, amountPerSession: number, discountPercent?: number, paymentMode?: string, schedule: { date: string, time: string }[], createdBy?: import('mongoose').Types.ObjectId, createdByRole?: string, planStatus?: string, workflowStatus?: string }} input
 */
export function applyHomePlanFields(booking, input) {
  const sessions = Number(input.sessions);
  const amountPerSession = Number(input.amountPerSession);
  const discountPercent = Number(input.discountPercent ?? 0);
  const paymentMode = input.paymentMode === 'offline' ? 'offline' : 'online';
  const schedule = input.schedule;

  const perVisitDistance = roundMoney2(Math.max(0, Number(booking.distanceSurchargeAmount) || 0));
  const linePerSession = roundMoney2(amountPerSession + perVisitDistance);
  const sessionSubtotal = sessions * linePerSession;
  const totalAmount = roundMoney2(sessionSubtotal * (1 - discountPercent / 100));
  if (totalAmount <= 0) {
    throw Object.assign(new Error('total amount after discount must be greater than 0'), {
      statusCode: 400,
    });
  }

  const perSessionCommission = getPlatformCommissionPerSessionSync();
  const platformEarning = roundMoney2(Math.min(totalAmount, perSessionCommission * sessions));
  const physioEarning = roundMoney2(totalAmount - platformEarning);

  booking.sessions = sessions;
  booking.schedule = schedule;
  booking.amountPerSession = amountPerSession;
  booking.discountPercent = discountPercent;
  booking.totalAmount = totalAmount;
  booking.amountPaise = Math.round(totalAmount * 100);
  booking.homePlanPaymentMode = paymentMode;
  booking.offlinePaymentVerified = false;
  booking.planStatus = input.planStatus ?? 'awaiting_consent';
  booking.workflowStatus = input.workflowStatus ?? 'awaiting_patient_consent';
  if (input.createdBy) {
    booking.planCreatedBy = input.createdBy;
    booking.planCreatedByRole = input.createdByRole || 'care_manager';
  }
  booking.payment = {
    mode: paymentMode,
    status: 'pending',
    amount: totalAmount,
    commission: platformEarning,
    physioEarning,
  };
}

export function validateHomePlanInput(body, { requirePhysioRate = null } = {}) {
  const sessions = Number(body?.sessions);
  const amountPerSession = Number(body?.amountPerSession);
  const discountPercent = Number(body?.discountPercent ?? 0);
  const paymentMode = body?.paymentMode === 'offline' ? 'offline' : 'online';

  if (!Number.isInteger(sessions) || sessions < 1) {
    return { error: 'sessions must be an integer greater than 0' };
  }
  const allowedSessions = getAllowedPlanSessionCountsSync();
  if (!allowedSessions.includes(sessions)) {
    return { error: `sessions must be one of ${allowedSessions.join(', ')}` };
  }
  if (!Array.isArray(body?.schedule) || body.schedule.length !== sessions) {
    return { error: 'schedule must match the number of sessions' };
  }
  const schedule = [];
  for (const item of body.schedule) {
    const date = String(item?.date || '').trim();
    const time = String(item?.time || '').trim();
    if (!date || !time) return { error: 'Each schedule entry needs date and time' };
    schedule.push({ date, time });
  }
  if (!Number.isFinite(amountPerSession) || amountPerSession <= 0) {
    return { error: 'amountPerSession must be greater than 0' };
  }
  if (requirePhysioRate != null && Number.isFinite(requirePhysioRate) && requirePhysioRate > 0) {
    if (amountPerSession !== requirePhysioRate) {
      return { error: `Per-session amount must be ₹${requirePhysioRate} (fixed session rate)` };
    }
  }
  const maxDiscount = getHomePlanMaxDiscountPercentSync();
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > maxDiscount) {
    return { error: `discountPercent must be between 0 and ${maxDiscount}` };
  }
  return { sessions, amountPerSession, discountPercent, paymentMode, schedule };
}
