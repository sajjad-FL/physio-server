import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { uploadsRoot } from '../config/upload.js';
import { isS3Configured, uploadPhysioAsset } from '../utils/s3Upload.js';
import { normalizeRole } from '../utils/userRole.js';

const GENDERS = new Set(['male', 'female', 'other', 'prefer_not_to_say']);

function resolveStoredUploadPath(avatarUrl) {
  if (!avatarUrl || typeof avatarUrl !== 'string' || !avatarUrl.startsWith('/uploads/')) return null;
  const rel = avatarUrl.slice('/uploads/'.length);
  const abs = path.join(uploadsRoot, rel);
  if (!abs.startsWith(uploadsRoot)) return null;
  return abs;
}

function unlinkAvatarFile(avatarUrl) {
  const abs = resolveStoredUploadPath(avatarUrl);
  if (abs && fs.existsSync(abs)) {
    try {
      fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }
}

function parseDob(input) {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  if (d > now) return null;
  const ageMs = now - d;
  const years = ageMs / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 13 || years > 120) return null;
  return d;
}

function parseEmail(input) {
  if (input === undefined) return undefined;
  if (input == null) return '';
  const email = String(input).trim().toLowerCase();
  if (!email) return '';
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return ok ? email : null;
}

export function parseAddressPayload(body) {
  const src = body || {};
  const hasAddress = Object.prototype.hasOwnProperty.call(src, 'address');
  const hasLegacy =
    Object.prototype.hasOwnProperty.call(src, 'location') ||
    Object.prototype.hasOwnProperty.call(src, 'lat') ||
    Object.prototype.hasOwnProperty.call(src, 'lng') ||
    Object.prototype.hasOwnProperty.call(src, 'coordinates');

  if (!hasAddress && !hasLegacy) {
    return { provided: false };
  }

  const fromAddress = hasAddress && src.address && typeof src.address === 'object' ? src.address : null;
  const textRaw = fromAddress ? fromAddress.text : src.location;
  const latRaw = fromAddress ? fromAddress.lat : src?.coordinates?.lat ?? src.lat;
  const lngRaw = fromAddress ? fromAddress.lng : src?.coordinates?.lng ?? src.lng;

  const text = String(textRaw ?? '').trim();
  const hasLat = latRaw !== '' && latRaw != null;
  const hasLng = lngRaw !== '' && lngRaw != null;

  if (hasLat !== hasLng) {
    return { provided: true, error: 'Address coordinates must include both lat and lng' };
  }

  let coords = null;
  if (hasLat && hasLng) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { provided: true, error: 'Address coordinates must be valid numbers' };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { provided: true, error: 'Address coordinates are out of range' };
    }
    coords = { lat, lng };
  }

  return {
    provided: true,
    value: {
      text,
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
    },
    location: text,
    coordinates: coords,
  };
}

function profileAddress(user) {
  const text = String(user?.address?.text || user?.location || '').trim();
  const lat = user?.address?.lat ?? user?.coordinates?.lat ?? null;
  const lng = user?.address?.lng ?? user?.coordinates?.lng ?? null;
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  return {
    text,
    lat: hasCoords ? lat : null,
    lng: hasCoords ? lng : null,
  };
}

function toIsoDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : null;
}

function isValidPhysioObjectId(physioId) {
  return physioId != null && physioId !== '' && mongoose.isValidObjectId(String(physioId));
}

export async function getProfile(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(userId)
      .select(
        'name email dob gender isProfileComplete phone role avatarUrl address location coordinates physioId isVerified hasPasswordLogin roles'
      )
      .lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    const role = normalizeRole(user);
    let physioProfile = null;
    let physioVerification = null;
    if (role === 'physio' && isValidPhysioObjectId(user.physioId)) {
      const physio = await Physiotherapist.findById(user.physioId)
        .select(
          'specialization experience pricePerSession pricePerSessionMax avatar verificationStatus isVerified verification verificationNote'
        )
        .lean();
      if (physio) {
        if (user.avatarUrl && !physio.avatar) {
          await Physiotherapist.findByIdAndUpdate(user.physioId, { $set: { avatar: user.avatarUrl } });
        }
        const lo = Number.isFinite(physio.pricePerSession) ? physio.pricePerSession : 0;
        const hi = physio.pricePerSessionMax != null ? Number(physio.pricePerSessionMax) : NaN;
        physioProfile = {
          specialization: physio.specialization || '',
          experience: Number.isFinite(physio.experience) ? physio.experience : 0,
          fees: lo,
          feesMax: Number.isFinite(hi) && hi > lo ? hi : null,
        };
        physioVerification = {
          status: physio.verificationStatus || 'pending',
          isVerified: physio.isVerified === true,
          rejectionReason: physio.verification?.rejectionReason || '',
        };
      }
    }

    return res.json({
      name: user.name || '',
      email: user.email || '',
      dob: toIsoDate(user.dob),
      gender: user.gender || null,
      isProfileComplete: user.isProfileComplete === true,
      phone: user.phone,
      role,
      avatarUrl: user.avatarUrl || '',
      address: profileAddress(user),
      physio: physioProfile,
      physioVerification,
    });
  } catch (err) {
    next(err);
  }
}

export async function patchProfile(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const name = String(req.body?.name ?? '').trim();
    const emailParsed = parseEmail(req.body?.email);
    const dobRaw = req.body?.dob;
    const gender = String(req.body?.gender ?? '').trim();
    const addressParsed = parseAddressPayload(req.body);
    const specializationRaw = req.body?.specialization;
    const experienceRaw = req.body?.experience;
    const feesRaw = req.body?.fees ?? req.body?.pricePerSession;
    const feesMaxRaw = req.body?.feesMax ?? req.body?.pricePerSessionMax;

    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }

    // if (emailParsed == null) {
    //   return res.status(400).json({ message: 'Please enter a valid email address' });
    // }

    const dob = parseDob(dobRaw);
    if (!dob) {
      return res.status(400).json({ message: 'Valid date of birth is required (age 13–120, not in the future)' });
    }

    if (!GENDERS.has(gender)) {
      return res.status(400).json({ message: 'Please choose a valid gender' });
    }

    if (addressParsed.error) {
      return res.status(400).json({ message: addressParsed.error });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.name = name;
    if (emailParsed !== undefined) {
      user.email = emailParsed;
    }
    user.dob = dob;
    user.gender = gender;
    if (addressParsed.provided) {
      user.address = addressParsed.value;
      user.location = addressParsed.location || '';
      user.coordinates = addressParsed.coordinates;
    }
    user.isProfileComplete = true;
    await user.save();

    let physioResponse = null;
    const isPhysioRole = normalizeRole(user) === 'physio';
    if (isValidPhysioObjectId(user.physioId)) {
      const physio = await Physiotherapist.findById(user.physioId);
      if (physio) {
        physio.name = name;
        physio.email = user.email || '';
        physio.dob = dob;
        physio.gender = gender;

        if (addressParsed.provided) {
          physio.address = addressParsed.value?.text || '';
          if (addressParsed.location) {
            physio.location = addressParsed.location;
          }
          physio.coordinates = addressParsed.coordinates;
        }

        if (isPhysioRole) {
          if (specializationRaw !== undefined) {
            const specialization = String(specializationRaw ?? '').trim();
            if (!specialization) {
              return res.status(400).json({ message: 'Specialization is required for physiotherapists' });
            }
            physio.specialization = specialization;
          }

          if (experienceRaw !== undefined) {
            const experience = Number(experienceRaw);
            if (!Number.isFinite(experience) || experience < 0 || experience > 80) {
              return res.status(400).json({ message: 'Experience must be a number between 0 and 80' });
            }
            physio.experience = experience;
          }

          if (feesRaw !== undefined) {
            const fees = Number(feesRaw);
            if (!Number.isFinite(fees) || fees < 0) {
              return res.status(400).json({ message: 'Fees must be a valid non-negative amount' });
            }
            physio.pricePerSession = fees;
          }

          if (feesMaxRaw !== undefined) {
            if (feesMaxRaw === null || feesMaxRaw === '') {
              physio.pricePerSessionMax = null;
            } else {
              const fm = Number(feesMaxRaw);
              if (!Number.isFinite(fm) || fm < 0) {
                return res.status(400).json({ message: 'Upper fee must be a valid non-negative amount' });
              }
              const lo = Number(physio.pricePerSession);
              if (Number.isFinite(fm) && Number.isFinite(lo) && fm > lo) {
                physio.pricePerSessionMax = fm;
              } else {
                physio.pricePerSessionMax = null;
              }
            }
          }
        }

        await physio.save();
        const loOut = Number.isFinite(physio.pricePerSession) ? physio.pricePerSession : 0;
        const hiOut = physio.pricePerSessionMax != null ? Number(physio.pricePerSessionMax) : NaN;
        physioResponse = {
          specialization: physio.specialization || '',
          experience: Number.isFinite(physio.experience) ? physio.experience : 0,
          fees: loOut,
          feesMax: Number.isFinite(hiOut) && hiOut > loOut ? hiOut : null,
        };
      }
    }

    const role = normalizeRole(user);
    return res.json({
      name: user.name,
      email: user.email || '',
      dob: toIsoDate(user.dob),
      gender: user.gender,
      isProfileComplete: true,
      phone: user.phone,
      role,
      avatarUrl: user.avatarUrl || '',
      address: profileAddress(user),
      physio: physioResponse,
    });
  } catch (err) {
    next(err);
  }
}

export async function patchAvatar(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    if (!req.file) {
      return res.status(400).json({ message: 'Image file is required' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const prev = user.avatarUrl;
    const publicPath =
      req.file.buffer && isS3Configured()
        ? await uploadPhysioAsset(
            req.file.buffer,
            `users/${userId}/avatar`,
            req.file.originalname,
            req.file.mimetype
          )
        : `/uploads/avatars/${req.file.filename}`;
    user.avatarUrl = publicPath;
    await user.save();

    if (isValidPhysioObjectId(user.physioId)) {
      const physio = await Physiotherapist.findById(user.physioId);
      if (physio) {
        physio.avatar = publicPath;
        await physio.save();
      }
    }

    if (prev && prev !== publicPath) {
      unlinkAvatarFile(prev);
    }

    return res.json({
      avatarUrl: user.avatarUrl,
    });
  } catch (err) {
    next(err);
  }
}
