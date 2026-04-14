import mongoose from 'mongoose';
import Physiotherapist from '../models/Physiotherapist.js';
import { distanceKm } from '../utils/geo.js';
import { isPhysioBookable, verificationBadgeLevel } from '../utils/physioVerification.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';

function parseCoordQuery(q) {
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query?.limit) || 10));
  return { page, limit, skip: (page - 1) * limit };
}

export async function createPhysio(req, res, next) {
  try {
    const { name, specialization, location, availability, isAvailable, phone, lat, lng, experience, pricePerSession } = req.body || {};
    if (!name?.trim() || !specialization?.trim() || !location?.trim()) {
      return res.status(400).json({ message: 'name, specialization, and location are required' });
    }

    let coordinates = null;
    if (lat != null && lng != null) {
      const la = Number(lat);
      const ln = Number(lng);
      if (!Number.isNaN(la) && !Number.isNaN(ln)) {
        coordinates = { lat: la, lng: ln };
      }
    }

    let phoneNorm = undefined;
    if (phone != null && String(phone).trim() !== '') {
      const pv = validateIndianMobile(phone);
      if (!pv.valid) {
        return res.status(400).json({ message: pv.message });
      }
      phoneNorm = pv.normalized;
    }

    const physio = await Physiotherapist.create({
      name: name.trim(),
      specialization: specialization.trim(),
      location: location.trim(),
      phone: phoneNorm,
      coordinates,
      availability:
        availability !== undefined
          ? Boolean(availability)
          : isAvailable !== undefined
            ? Boolean(isAvailable)
            : true,
      isAvailable:
        isAvailable !== undefined
          ? Boolean(isAvailable)
          : availability !== undefined
            ? Boolean(availability)
            : true,
      experience: Number.isFinite(Number(experience)) ? Math.max(0, Number(experience)) : 0,
      pricePerSession: Number.isFinite(Number(pricePerSession))
        ? Math.max(0, Number(pricePerSession))
        : 500,
      verificationStatus: 'pending',
      isVerified: false,
      documents: [],
    });

    return res.status(201).json(physio.toObject());
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: 'Phone already registered' });
    }
    next(err);
  }
}

export async function getPublicPhysioProfile(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid physiotherapist id' });
    }
    const physio = await Physiotherapist.findOne({
      _id: id,
      verificationStatus: 'approved',
      isVerified: true,
    })
      .select(
        'name specialization experience pricePerSession pricePerSessionMax location serviceType avatar avgRating totalReviews coordinates phone'
      )
      .lean();
    if (!physio) {
      return res.status(404).json({ message: 'Physiotherapist not found' });
    }
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

export async function listPhysios(req, res, next) {
  try {
    const { page, limit, skip } = readPagination(req.query);
    const listSelect =
      'name specialization experience pricePerSession pricePerSessionMax location phone coordinates availability isAvailable isVerified verificationStatus status avatar avgRating totalReviews createdAt';
    const [list, total] = await Promise.all([
      Physiotherapist.find()
        .select(listSelect)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Physiotherapist.countDocuments(),
    ]);
    return res.json({
      data: list,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}

const NEARBY_LEAN_SELECT =
  'name specialization experience pricePerSession pricePerSessionMax location coordinates availability isAvailable verificationStatus isVerified verification avatar avgRating totalReviews geoPoint';

function toNearbyDto(p, distanceKmVal) {
  return {
    _id: p._id,
    name: p.name,
    phone: p.phone || '',
    specialization: p.specialization,
    experience: p.experience ?? 0,
    pricePerSession: p.pricePerSession ?? 0,
    pricePerSessionMax:
      p.pricePerSessionMax != null && Number(p.pricePerSessionMax) > Number(p.pricePerSession ?? 0)
        ? p.pricePerSessionMax
        : null,
    location: p.location,
    coordinates: p.coordinates || null,
    distanceKm: distanceKmVal,
    availability: p.availability !== false,
    isAvailable: p.isAvailable !== false,
    verificationBadgeLevel: verificationBadgeLevel(p),
    avatar: p.avatar || '',
    avgRating: Number(p.avgRating) || 0,
    totalReviews: Number(p.totalReviews) || 0,
  };
}

export async function listNearbyPhysios(req, res, next) {
  try {
    const coords = parseCoordQuery(req.query);
    if (!coords) {
      return res.status(400).json({ message: 'lat and lng query params are required' });
    }

    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const baseFilter = {
      $or: [{ availability: true }, { isAvailable: true }],
      verificationStatus: 'approved',
      isVerified: true,
    };

    const byId = new Map();

    try {
      const geoHits = await Physiotherapist.find({
        ...baseFilter,
        geoPoint: {
          $nearSphere: {
            $geometry: { type: 'Point', coordinates: [coords.lng, coords.lat] },
            $maxDistance: 2_500_000,
          },
        },
      })
        .select(NEARBY_LEAN_SELECT)
        .limit(Math.max(limit * 12, 48))
        .lean();

      for (const p of geoHits) {
        byId.set(String(p._id), p);
      }
    } catch (geoErr) {
      console.warn('[physios/nearby] geo query skipped:', geoErr?.message || geoErr);
    }

    if (byId.size < limit * 4) {
      const legacyHits = await Physiotherapist.find({
        ...baseFilter,
        $or: [{ geoPoint: { $exists: false } }, { geoPoint: null }],
        'coordinates.lat': { $exists: true, $ne: null },
        'coordinates.lng': { $exists: true, $ne: null },
      })
        .select(NEARBY_LEAN_SELECT)
        .limit(400)
        .lean();

      for (const p of legacyHits) {
        if (!byId.has(String(p._id))) {
          byId.set(String(p._id), p);
        }
      }
    }

    if (byId.size === 0) {
      const capped = await Physiotherapist.find(baseFilter)
        .select(NEARBY_LEAN_SELECT)
        .limit(500)
        .lean();
      for (const p of capped) {
        byId.set(String(p._id), p);
      }
    }

    const merged = [...byId.values()];
    const bookable = merged.filter((p) => isPhysioBookable(p));

    const withCoords = bookable.filter(
      (p) => p.coordinates?.lat != null && p.coordinates?.lng != null
    );
    const nearby = withCoords
      .map((p) => ({
        p,
        d: distanceKm(coords.lat, coords.lng, p.coordinates.lat, p.coordinates.lng),
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(({ p, d }) => toNearbyDto(p, d));

    if (nearby.length > 0) {
      return res.json({ physios: nearby, fallbackUsed: false });
    }

    const fallback = bookable.slice(0, limit).map((p) => toNearbyDto(p, null));

    return res.json({
      physios: fallback,
      fallbackUsed: true,
      message: 'No nearby physios, showing closest available',
    });
  } catch (err) {
    next(err);
  }
}
