import { resolveAuthFromBearer } from '../utils/authResolve.js';
import { requireCompleteProfile } from './requireCompleteProfile.js';

/** Dispute routes: verified JWT with `user` and/or `physio` role. Sets `req.auth`. */
export async function requirePatientOrPhysio(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const bearer = authHeader.slice('Bearer '.length).trim();
    const ctx = await resolveAuthFromBearer(bearer);
    if (!ctx) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const canUser = ctx.role === 'user';
    const canPhysio = ctx.role === 'physio' && ctx.physioId;
    if (!canUser && !canPhysio) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    req.auth = ctx;
    req.user = { id: ctx.userId, phone: ctx.phone, role: ctx.role };
    // Physios may use the workspace before User.isProfileComplete (onboarding / approval).
    // ProfileCompletionGate allows that for physio; keep dispute APIs consistent.
    if (ctx.role === 'physio') {
      return next();
    }
    return requireCompleteProfile(req, res, next);
  } catch {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}
