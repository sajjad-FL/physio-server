import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

function mergeRoles(existing, additions) {
  const set = new Set([...(Array.isArray(existing) ? existing : []), ...additions]);
  return Array.from(set);
}

/**
 * Hydrate auth context from a verified JWT payload + DB.
 * @param {object} decoded
 * @returns {Promise<{ userId: string, roles: string[], phone?: string, physioId: string | null } | null>}
 */
export async function hydrateAuthFromDecoded(decoded) {
  if (!decoded || typeof decoded !== 'object') return null;

  const userId = decoded.userId || null;

  // New format: userId + roles on token (roles refreshed from DB below)
  if (userId) {
    const user = await User.findById(userId).lean();
    if (!user || !user.isVerified) return null;
    return {
      userId: user._id.toString(),
      roles: Array.isArray(user.roles) && user.roles.length ? user.roles : ['user'],
      phone: user.phone,
      physioId: user.physioId ? user.physioId.toString() : null,
      isProfileComplete: user.isProfileComplete === true,
    };
  }

  // Legacy: physiotherapist token (sub was physio id)
  if (decoded.role === 'physio' && decoded.physioId) {
    const physio = await Physiotherapist.findById(decoded.physioId).lean();
    if (!physio?.phone) return null;

    let user =
      (await User.findOne({ phone: physio.phone })) ||
      (await User.create({
        phone: physio.phone,
        name: physio.name,
        isVerified: true,
        roles: mergeRoles([], ['user', 'physio']),
        physioId: physio._id,
      }));

    user.roles = mergeRoles(user.roles, ['user', 'physio']);
    user.physioId = physio._id;
    user.isVerified = true;
    await user.save();

    const fresh = await User.findById(user._id).lean();
    return {
      userId: fresh._id.toString(),
      roles: fresh.roles,
      phone: fresh.phone,
      physioId: fresh.physioId ? fresh.physioId.toString() : String(decoded.physioId),
      isProfileComplete: fresh.isProfileComplete === true,
    };
  }

  // Legacy: patient token (sub = user id)
  const legacyUserId = decoded.sub;
  if (legacyUserId && decoded.role !== 'physio') {
    const user = await User.findById(legacyUserId).lean();
    if (!user || !user.isVerified) return null;
    const roles =
      Array.isArray(user.roles) && user.roles.length ? user.roles : mergeRoles([], ['user']);
    return {
      userId: user._id.toString(),
      roles,
      phone: user.phone,
      physioId: user.physioId ? user.physioId.toString() : null,
      isProfileComplete: user.isProfileComplete === true,
    };
  }

  return null;
}

export async function resolveAuthFromBearer(bearer) {
  if (!bearer) return null;
  const decoded = jwt.verify(bearer, JWT_SECRET);
  return hydrateAuthFromDecoded(decoded);
}

export { JWT_SECRET };
