import {
  getClinicSessionPricingSync,
  getClinicSessionSplitSync,
} from './pricingConfig.js';

/**
 * Apply clinic assignment + pricing snapshots onto a booking document (not saved).
 * Preserves existing plan totals when present (manager-referred home → clinic).
 * Technique bookings keep technique_* carePath and existing technique pricing.
 * @param {import('mongoose').Document} booking
 * @param {{ clinicId: string, assignedBy: string, clinicSource: 'direct'|'manager_referred' }} opts
 */
export function applyClinicAssignment(booking, { clinicId, assignedBy, clinicSource }) {
  const isTechnique =
    booking.carePath === 'technique_direct' || booking.carePath === 'technique_managed';
  const includeManager =
    clinicSource === 'manager_referred' || booking.carePath === 'technique_managed';
  const pricing = getClinicSessionPricingSync();
  const split = getClinicSessionSplitSync(includeManager);

  booking.clinicId = clinicId;
  booking.clinicSource = clinicSource;
  booking.clinicAssignedAt = new Date();
  booking.clinicAssignedBy = assignedBy;
  booking.serviceType = 'clinic';
  if (!isTechnique) {
    booking.carePath = 'clinic_visit';
    booking.workflowStatus = 'clinic_assigned';
  }
  if (booking.status === 'pending') booking.status = 'assigned';

  booking.clinicCommissionPerSession = Number(split.clinic) || 0;
  if (includeManager) {
    if (booking.managerCommissionPerSession == null) {
      booking.managerCommissionPerSession = Number(split.manager) || 0;
    }
  } else if (!isTechnique) {
    booking.managerCommissionPerSession = 0;
  }

  const hasPlanTotal = Number(booking.totalAmount) > 0;
  if (!hasPlanTotal) {
    const sessions = Math.max(1, Number(booking.sessions) || 1);
    booking.sessions = sessions;
    booking.amountPerSession = Number(pricing.totalAmount) || 0;
    booking.totalAmount = Number(pricing.totalAmount) * sessions;
    if (!booking.payment) booking.payment = {};
    booking.payment.mode = 'offline';
    booking.payment.amount = booking.totalAmount;
    booking.payment.commission = Number(split.platform) * sessions;
    booking.payment.physioEarning = 0;
    booking.homePlanPaymentMode = 'offline';
    booking.homePlanBillingType = 'full';
    booking.planStatus = 'live';
    booking.planLiveAt = new Date();
  }
}
