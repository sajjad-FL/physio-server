import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { hydrateAuthFromDecoded, JWT_SECRET } from '../utils/authResolve.js';
import { requireCompleteProfile } from './requireCompleteProfile.js';

/**
 * Allows admin (Bearer ADMIN_API_KEY), JWT with admin role, patient JWT, or physio JWT to read notes.
 */
export async function requireNotesAccess(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.slice('Bearer '.length);
  const adminKey = process.env.ADMIN_API_KEY;

  if (adminKey && token === adminKey) {
    req.admin = true;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const ctx = await hydrateAuthFromDecoded(decoded);
    if (!ctx) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (ctx.roles.includes('admin')) {
      req.admin = true;
      req.auth = ctx;
      req.user = { id: ctx.userId, roles: ctx.roles };
      return requireCompleteProfile(req, res, next);
    }

    if (ctx.roles.includes('physio') && ctx.physioId) {
      req.physio = { id: ctx.physioId };
      req.auth = ctx;
      return requireCompleteProfile(req, res, next);
    }

    if (ctx.roles.includes('user')) {
      const user = await User.findById(ctx.userId).lean();
      if (user?.isVerified) {
        req.user = { id: user._id.toString() };
        req.auth = ctx;
        return requireCompleteProfile(req, res, next);
      }
    }
  } catch {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  return res.status(401).json({ message: 'Unauthorized' });
}
