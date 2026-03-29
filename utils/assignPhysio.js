import Booking from '../models/Booking.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { distanceKm } from './geo.js';
import { isPhysioBookable } from './physioVerification.js';

function hasCoords(c) {
  return c && typeof c.lat === 'number' && typeof c.lng === 'number';
}

export async function assignPhysioForBooking(booking, userCoords, userLocationString) {
  if (!booking?._id) return booking;

  const query = {
    $or: [{ availability: true }, { isAvailable: true }],
    verificationStatus: 'approved',
    isVerified: true,
  };

  const physios = (await Physiotherapist.find(query).lean()).filter((p) => isPhysioBookable(p));

  if (physios.length === 0) {
    await Booking.findByIdAndUpdate(booking._id, {
      physioId: null,
      status: 'pending',
    });
    return booking;
  }

  let best = null;
  let bestDist = Infinity;

  if (hasCoords(userCoords)) {
    for (const p of physios) {
      if (!hasCoords(p.coordinates)) continue;
      const d = distanceKm(userCoords.lat, userCoords.lng, p.coordinates.lat, p.coordinates.lng);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
  }

  if (!best) {
    const loc = String(userLocationString || '').trim();
    if (loc) {
      best = physios.find((p) => String(p.location || '').trim() === loc) || null;
    }
  }

  if (!best && physios.length > 0) {
    best = physios.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
  }

  if (!best) {
    await Booking.findByIdAndUpdate(booking._id, {
      physioId: null,
      status: 'pending',
    });
    return booking;
  }

  const updated = await Booking.findByIdAndUpdate(
    booking._id,
    {
      physioId: best._id,
      status: 'assigned',
    },
    { new: true }
  ).populate('physioId', 'name specialization location phone coordinates');

  return updated;
}
