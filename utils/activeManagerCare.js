import Booking from '../models/Booking.js';

/**
 * Find the patient's active recovery-plan booking that already has a care manager.
 * Used to attach that manager (with commission) to new technique bookings.
 *
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @returns {Promise<{ managerId: import('mongoose').Types.ObjectId, zoneId: import('mongoose').Types.ObjectId|null, pincode: string|null } | null>}
 */
export async function findActiveManagerCare(userId) {
  if (!userId) return null;

  const active = await Booking.findOne({
    userId,
    serviceType: 'home',
    carePath: 'standard',
    managerId: { $ne: null },
    status: { $ne: 'completed' },
    sessionStatus: { $ne: 'completed' },
    $or: [
      { planStatus: { $in: ['live', 'approved'] } },
      { workflowStatus: { $in: ['plan_live', 'payment_recorded', 'in_treatment'] } },
    ],
  })
    .sort({ updatedAt: -1 })
    .select('managerId zoneId pincode')
    .lean();

  if (!active?.managerId) return null;

  return {
    managerId: active.managerId,
    zoneId: active.zoneId || null,
    pincode: active.pincode || null,
  };
}
