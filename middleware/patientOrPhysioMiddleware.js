import { resolveAuthFromBearer } from '../utils/authResolve.js';
import User from '../models/User.js';
import { requireCompleteProfile } from './requireCompleteProfile.js';

/** Dispute routes: verified JWT with `user` and/or `physio` role. Sets `req.auth`. */
export async function requirePatientOrPhysio(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const bearer = authHeader.slice('Bearer '.length);
    const ctx = await resolveAuthFromBearer(bearer);
    if (!ctx) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user = await User.findById(ctx.userId).lean();
    if (!user || !user.isVerified) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const canUser = ctx.roles.includes('user');
    const canPhysio = ctx.roles.includes('physio') && ctx.physioId;
    if (!canUser && !canPhysio) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    req.auth = ctx;
    req.user = { id: ctx.userId, phone: ctx.phone, roles: ctx.roles };
    return requireCompleteProfile(req, res, next);
  } catch {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}
