import Booking from '../models/Booking.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { DAILY_SLOTS } from '../config/slots.js';
import { isPhysioBookable } from './physioVerification.js';

/** Primary-slot bookings that still consume platform capacity for that hour. */
const ACTIVE_PRIMARY_SLOT_FILTER = {
  status: { $ne: 'completed' },
  paymentStatus: { $ne: 'refunded' },
};

export async function getBookablePhysioCount() {
  const docs = await Physiotherapist.find()
    .select('isVerified verificationStatus verification availability isAvailable')
    .lean();
  return docs.filter(isPhysioBookable).length;
}

export async function countActivePrimaryBookingsForSlot(date, timeSlot) {
  return Booking.countDocuments({
    date,
    timeSlot,
    ...ACTIVE_PRIMARY_SLOT_FILTER,
  });
}

/** @returns {Map<string, number>} timeSlot → count */
export async function countActivePrimaryBookingsBySlotForDate(date) {
  const rows = await Booking.aggregate([
    {
      $match: {
        date,
        timeSlot: { $in: [...DAILY_SLOTS] },
        ...ACTIVE_PRIMARY_SLOT_FILTER,
      },
    },
    { $group: { _id: '$timeSlot', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.count]));
}
