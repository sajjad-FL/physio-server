import jwt from 'jsonwebtoken';
import { hydrateAuthFromDecoded, JWT_SECRET } from '../utils/authResolve.js';
import { requireCompleteProfile } from './requireCompleteProfile.js';

/**
 * Requires a JWT whose role resolves to `admin`. The role is read from the user's
 * DB document (see hydrateAuthFromDecoded), not the token claim, so it cannot be
 * forged. There is no static admin API key.
 */
export async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!bearer) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    let decoded;
    try {
      decoded = jwt.verify(bearer, JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const ctx = await hydrateAuthFromDecoded(decoded);
    if (ctx?.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }
    req.admin = true;
    req.auth = ctx;
    req.user = { id: ctx.userId, phone: ctx.phone, role: ctx.role };
    return requireCompleteProfile(req, res, next);
  } catch (err) {
    next(err);
  }
}
