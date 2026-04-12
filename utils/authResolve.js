import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { normalizeRole } from './userRole.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

function canAuthenticateUser(user) {
  if (!user) return false;
  return Boolean(
    user.isVerified || user.hasPasswordLogin || user.passwordHash,
  );
}

/**
 * Hydrate auth context from a verified JWT payload + DB.
 * @param {object} decoded
 * @returns {Promise<{ userId: string, role: 'user'|'physio'|'admin', phone?: string, physioId: string | null, isProfileComplete: boolean } | null>}
 */
export async function hydrateAuthFromDecoded(decoded) {
  if (!decoded || typeof decoded !== 'object') return null;

  const candidateUserId = decoded.userId || decoded.sub || null;

  if (candidateUserId && mongoose.isValidObjectId(String(candidateUserId))) {
    const user = await User.findById(candidateUserId).select('+passwordHash').lean();
    if (user && canAuthenticateUser(user)) {
      const role = normalizeRole(user);
      let physioId = user.physioId ? user.physioId.toString() : null;
      if (
        role === 'physio' &&
        !physioId &&
        decoded.physioId &&
        mongoose.isValidObjectId(String(decoded.physioId))
      ) {
        physioId = String(decoded.physioId);
      }
      return {
        userId: user._id.toString(),
        role,
        phone: user.phone,
        physioId,
        isProfileComplete: user.isProfileComplete === true,
      };
    }
  }

  // Legacy: physiotherapist token (often `sub` was physio id, sometimes `physioId`).
  const legacyPhysioId =
    decoded.role === 'physio'
      ? decoded.physioId || decoded.sub || null
      : null;
  if (legacyPhysioId && mongoose.isValidObjectId(String(legacyPhysioId))) {
    const physio = await Physiotherapist.findById(legacyPhysioId).lean();
    if (!physio?.phone) return null;

    let user =
      (await User.findOne({ phone: physio.phone })) ||
      (await User.create({
        phone: physio.phone,
        name: physio.name,
        isVerified: true,
        role: 'physio',
        physioId: physio._id,
      }));

    user.role = 'physio';
    user.physioId = physio._id;
    user.isVerified = true;
    await user.save();

    const fresh = await User.findById(user._id).lean();
    return {
      userId: fresh._id.toString(),
      role: normalizeRole(fresh),
      phone: fresh.phone,
      physioId: fresh.physioId ? fresh.physioId.toString() : String(legacyPhysioId),
      isProfileComplete: fresh.isProfileComplete === true,
    };
  }

  return null;
}

export async function resolveAuthFromBearer(bearer) {
  if (!bearer || typeof bearer !== 'string') return null;
  const trimmed = bearer.trim();
  if (!trimmed) return null;
  try {
    const decoded = jwt.verify(trimmed, JWT_SECRET);
    return await hydrateAuthFromDecoded(decoded);
  } catch {
    return null;
  }
}
