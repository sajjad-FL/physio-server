import { DAILY_SLOTS, todayYMDLocal, isSlotStartInPastForToday } from '../config/slots.js';
import {
  getBookablePhysioCount,
  countActivePrimaryBookingsBySlotForDate,
} from '../utils/slotCapacity.js';

function isValidDateString(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00.000Z');
  return !Number.isNaN(d.getTime());
}

export async function getSlots(req, res, next) {
  try {
    const date = req.query?.date;
    if (!date || !isValidDateString(date)) {
      return res.status(400).json({ message: 'date must be YYYY-MM-DD' });
    }

    const todayYmd = todayYMDLocal();
    if (date < todayYmd) {
      return res.status(400).json({ message: 'date must be today or in the future' });
    }

    const capacity = await getBookablePhysioCount();
    const bookedBySlot = await countActivePrimaryBookingsBySlotForDate(date);

    const slots = DAILY_SLOTS.map((timeSlot) => {
      const past = date === todayYmd && isSlotStartInPastForToday(timeSlot);
      const booked = bookedBySlot.get(timeSlot) || 0;
      const available = !past && capacity > 0 && booked < capacity;
      return { timeSlot, available, booked, capacity };
    });

    return res.json({ date, slots });
  } catch (err) {
    next(err);
  }
}
