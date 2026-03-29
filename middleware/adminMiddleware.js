import jwt from 'jsonwebtoken';
import { hydrateAuthFromDecoded, JWT_SECRET } from '../utils/authResolve.js';
import { requireCompleteProfile } from './requireCompleteProfile.js';

/**
 * Allows admin via `ADMIN_API_KEY` (Bearer or x-admin-key) or JWT with `admin` role.
 */
export async function requireAdmin(req, res, next) {
  try {
    const key = process.env.ADMIN_API_KEY;
    if (!key) {
      return res.status(503).json({ message: 'Admin API is not configured' });
    }

    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const headerKey = req.headers['x-admin-key'];

    if (bearer === key || headerKey === key) {
      req.admin = true;
      return next();
    }

    if (!bearer) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const decoded = jwt.verify(bearer, JWT_SECRET);
    const ctx = await hydrateAuthFromDecoded(decoded);
    if (!ctx?.roles?.includes('admin')) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    req.admin = true;
    req.auth = ctx;
    req.user = { id: ctx.userId, phone: ctx.phone, roles: ctx.roles };
    return requireCompleteProfile(req, res, next);
  } catch (err) {
    next(err);
  }
}
