import mongoose from 'mongoose';
import ServiceZone from '../models/ServiceZone.js';
import Booking from '../models/Booking.js';
import User from '../models/User.js';
import { normalizePincode } from '../utils/pincode.js';
import { pickLeastLoadedManager } from '../utils/zoneAssign.js';

function normalizePincodes(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((p) => normalizePincode(p)).filter(Boolean))];
}

export async function listZones(req, res, next) {
  try {
    const zones = await ServiceZone.find()
      .sort({ name: 1 })
      .populate('managerIds', 'name phone')
      .populate('physioIds', 'name phone specialization')
      .lean();
    return res.json({ zones });
  } catch (err) {
    next(err);
  }
}

export async function getZone(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid zone id' });
    }
    const zone = await ServiceZone.findById(id)
      .populate('managerIds', 'name phone')
      .populate('physioIds', 'name phone specialization')
      .lean();
    if (!zone) return res.status(404).json({ message: 'Zone not found' });
    return res.json(zone);
  } catch (err) {
    next(err);
  }
}

export async function createZone(req, res, next) {
  try {
    const { name, city, region, pincodes, managerIds, physioIds, isActive } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ message: 'name is required' });

    const zone = await ServiceZone.create({
      name: name.trim(),
      city: String(city || '').trim(),
      region: String(region || '').trim(),
      pincodes: normalizePincodes(pincodes),
      managerIds: Array.isArray(managerIds) ? managerIds.filter((id) => mongoose.isValidObjectId(id)) : [],
      physioIds: Array.isArray(physioIds) ? physioIds.filter((id) => mongoose.isValidObjectId(id)) : [],
      isActive: isActive !== false,
    });

    const out = await ServiceZone.findById(zone._id)
      .populate('managerIds', 'name phone')
      .populate('physioIds', 'name phone specialization')
      .lean();
    return res.status(201).json(out);
  } catch (err) {
    next(err);
  }
}

export async function updateZone(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid zone id' });
    }

    const zone = await ServiceZone.findById(id);
    if (!zone) return res.status(404).json({ message: 'Zone not found' });

    const { name, city, region, pincodes, managerIds, physioIds, isActive } = req.body || {};
    if (name !== undefined) zone.name = String(name).trim();
    if (city !== undefined) zone.city = String(city).trim();
    if (region !== undefined) zone.region = String(region).trim();
    if (pincodes !== undefined) zone.pincodes = normalizePincodes(pincodes);
    if (managerIds !== undefined) {
      zone.managerIds = Array.isArray(managerIds)
        ? managerIds.filter((mid) => mongoose.isValidObjectId(mid))
        : [];
    }
    if (physioIds !== undefined) {
      zone.physioIds = Array.isArray(physioIds)
        ? physioIds.filter((pid) => mongoose.isValidObjectId(pid))
        : [];
    }
    if (isActive !== undefined) zone.isActive = Boolean(isActive);

    await zone.save();

    const out = await ServiceZone.findById(id)
      .populate('managerIds', 'name phone')
      .populate('physioIds', 'name phone specialization')
      .lean();
    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function addZonePincodes(req, res, next) {
  try {
    const { id } = req.params;
    const incoming = normalizePincodes(req.body?.pincodes);
    if (!incoming.length) return res.status(400).json({ message: 'pincodes array is required' });

    const zone = await ServiceZone.findById(id);
    if (!zone) return res.status(404).json({ message: 'Zone not found' });

    const merged = [...new Set([...(zone.pincodes || []), ...incoming])];
    zone.pincodes = merged;
    await zone.save();
    return res.json(zone);
  } catch (err) {
    next(err);
  }
}

export async function assignManagerToBooking(req, res, next) {
  try {
    const { id } = req.params;
    const { managerId } = req.body || {};

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }
    if (!mongoose.isValidObjectId(managerId)) {
      return res.status(400).json({ message: 'Invalid manager id' });
    }

    const manager = await User.findById(managerId).select('role name').lean();
    if (!manager || manager.role !== 'care_manager') {
      return res.status(400).json({ message: 'User is not a care manager' });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    booking.managerId = managerId;
    booking.managerAssignedAt = new Date();
    booking.workflowStatus = 'manager_assigned';
    await booking.save();

    const out = await Booking.findById(id)
      .populate('userId', 'name phone location pincode')
      .populate('managerId', 'name phone')
      .populate('physioId', 'name specialization phone')
      .lean();

    return res.json(out);
  } catch (err) {
    next(err);
  }
}

export async function reassignManager(req, res, next) {
  return assignManagerToBooking(req, res, next);
}

export async function listCareManagers(req, res, next) {
  try {
    const [managers, zones] = await Promise.all([
      User.find({ role: 'care_manager' })
        .select('name phone pincode location coordinates avatarUrl createdAt')
        .sort({ name: 1 })
        .lean(),
      ServiceZone.find({ isActive: { $ne: false } })
        .select('name pincodes managerIds')
        .lean(),
    ]);

    const enriched = managers.map((m) => {
      const managerZones = zones.filter((z) =>
        (z.managerIds || []).some((id) => String(id) === String(m._id)),
      );
      return {
        ...m,
        zones: managerZones.map((z) => ({
          _id: z._id,
          name: z.name,
          pincodes: z.pincodes || [],
        })),
      };
    });

    return res.json({ managers: enriched });
  } catch (err) {
    next(err);
  }
}

export async function promoteToCareManager(req, res, next) {
  try {
    const { userId } = req.body || {};
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === 'admin') {
      return res.status(400).json({ message: 'Cannot change admin role' });
    }
    user.role = 'care_manager';
    await user.save();
    return res.json({ user: { _id: user._id, name: user.name, phone: user.phone, role: user.role } });
  } catch (err) {
    next(err);
  }
}

export async function listUnmappedPincodes(req, res, next) {
  try {
    const bookings = await Booking.find({
      serviceType: 'home',
      pincode: { $exists: true, $ne: null },
      zoneId: null,
    })
      .select('pincode createdAt issue')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const counts = {};
    for (const b of bookings) {
      counts[b.pincode] = (counts[b.pincode] || 0) + 1;
    }
    return res.json({ pincodes: counts, recentBookings: bookings });
  } catch (err) {
    next(err);
  }
}

export { pickLeastLoadedManager };
