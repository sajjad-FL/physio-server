import Physiotherapist from '../models/Physiotherapist.js';
import { DAILY_SLOTS, todayYMDLocal, isSlotStartInPastForToday } from '../config/slots.js';
import {
  getBookablePhysioCount,
  countActivePrimaryBookingsBySlotForDate,
} from '../utils/slotCapacity.js';
import { isPhysioBookable } from '../utils/physioVerification.js';
import { distanceKm } from '../utils/geo.js';

const DEFAULT_SERVICE_AREA = {
  label: 'Kokrajhar',
  lat: 26.4014,
  lng: 90.2667,
};

const NEARBY_RADIUS_KM = 50;

function parseCoords(query) {
  const lat = Number(query?.lat);
  const lng = Number(query?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { lat: DEFAULT_SERVICE_AREA.lat, lng: DEFAULT_SERVICE_AREA.lng };
  }
  return { lat, lng };
}

/**
 * Public marketplace stats for the patient home screen.
 * activeSpecialists = verified, available physios within NEARBY_RADIUS_KM.
 * bookingRateToday = share of today's remaining slot capacity already booked.
 */
export async function getHomeMarketplaceStats(req, res, next) {
  try {
    const coords = parseCoords(req.query);
    const serviceArea =
      String(req.query.city || req.query.area || DEFAULT_SERVICE_AREA.label).trim() ||
      DEFAULT_SERVICE_AREA.label;

    const baseFilter = {
      $or: [{ availability: true }, { isAvailable: true }],
      verificationStatus: 'approved',
      isVerified: true,
    };

    const docs = await Physiotherapist.find(baseFilter)
      .select('coordinates availability isAvailable verificationStatus isVerified')
      .lean();

    const bookable = docs.filter(isPhysioBookable);
    const nearbyCount = bookable.filter((p) => {
      const plat = p.coordinates?.lat;
      const plng = p.coordinates?.lng;
      if (plat == null || plng == null) return false;
      return distanceKm(coords.lat, coords.lng, plat, plng) <= NEARBY_RADIUS_KM;
    }).length;

    const activeSpecialists = nearbyCount > 0 ? nearbyCount : bookable.length;

    const capacity = await getBookablePhysioCount();
    const todayYmd = todayYMDLocal();
    const bookedBySlot = await countActivePrimaryBookingsBySlotForDate(todayYmd);

    let totalBooked = 0;
    let totalSlotCapacity = 0;
    for (const timeSlot of DAILY_SLOTS) {
      if (isSlotStartInPastForToday(timeSlot)) continue;
      const booked = bookedBySlot.get(timeSlot) || 0;
      totalBooked += booked;
      if (capacity > 0) totalSlotCapacity += capacity;
    }

    const bookingRateToday =
      totalSlotCapacity > 0
        ? Math.min(100, Math.round((totalBooked / totalSlotCapacity) * 100))
        : null;

    return res.json({
      serviceArea,
      activeSpecialists,
      bookingRateToday,
      platformCapacity: capacity,
      coords,
    });
  } catch (err) {
    next(err);
  }
}
