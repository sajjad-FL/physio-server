import Booking from '../models/Booking.js';
import { DAILY_SLOTS, todayYMDLocal, isSlotStartInPastForToday } from '../config/slots.js';

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

    const bookings = await Booking.find({ date }).select({ timeSlot: 1 }).lean();
    const taken = new Set(bookings.map((b) => b.timeSlot).filter(Boolean));

    const slots = DAILY_SLOTS.map((timeSlot) => {
      let available = !taken.has(timeSlot);
      if (date === todayYmd && isSlotStartInPastForToday(timeSlot)) {
        available = false;
      }
      return { timeSlot, available };
    });

    return res.json({ date, slots });
  } catch (err) {
    next(err);
  }
}
