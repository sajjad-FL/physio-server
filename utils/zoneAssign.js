import ServiceZone from '../models/ServiceZone.js';
import Booking from '../models/Booking.js';
import { normalizePincode } from './pincode.js';

/**
 * Pick the manager with fewest active bookings among zone managers (least-loaded).
 * @param {import('mongoose').Types.ObjectId[]} managerIds
 */
export async function pickLeastLoadedManager(managerIds) {
  if (!Array.isArray(managerIds) || managerIds.length === 0) return null;
  if (managerIds.length === 1) return managerIds[0];

  const counts = await Booking.aggregate([
    {
      $match: {
        managerId: { $in: managerIds },
        status: { $nin: ['completed'] },
      },
    },
    { $group: { _id: '$managerId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
  let best = managerIds[0];
  let bestCount = Infinity;
  for (const mid of managerIds) {
    const c = countMap.get(String(mid)) ?? 0;
    if (c < bestCount) {
      bestCount = c;
      best = mid;
    }
  }
  return best;
}

/**
 * Resolve active zone by pincode and auto-assign manager on a booking document (not saved).
 * @param {{ pincode?: string | null, location?: string | null }} source
 * @param {import('mongoose').Document} booking
 */
export async function applyZoneAndManager(booking, source = {}) {
  const pincode =
    normalizePincode(source.pincode) ||
    normalizePincode(source.location) ||
    normalizePincode(booking.pincode);
  if (!pincode) {
    booking.workflowStatus = booking.workflowStatus || 'pending_manager_assignment';
    return { pincode: null, zone: null, managerId: null };
  }

  booking.pincode = pincode;
  const zone = await ServiceZone.findOne({
    isActive: true,
    pincodes: pincode,
  }).lean();

  if (!zone) {
    booking.workflowStatus = 'pending_manager_assignment';
    return { pincode, zone: null, managerId: null };
  }

  booking.zoneId = zone._id;
  const managerId = await pickLeastLoadedManager(zone.managerIds || []);
  if (managerId) {
    booking.managerId = managerId;
    booking.managerAssignedAt = new Date();
    booking.workflowStatus = 'manager_assigned';
  } else {
    booking.workflowStatus = 'pending_manager_assignment';
  }
  return { pincode, zone, managerId: managerId || null };
}
