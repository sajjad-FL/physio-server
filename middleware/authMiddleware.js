import jwt from 'jsonwebtoken';
import { authenticateJwt } from './authenticateJwt.js';
import { requireRoles } from './rbacMiddleware.js';
import { requireCompleteProfile } from './requireCompleteProfile.js';
import { JWT_SECRET } from '../utils/authResolve.js';

/** Patient / user-tier routes: verified JWT with `user` or `admin` (via hierarchy). */
export function requireAuth(req, res, next) {
  authenticateJwt(req, res, () => {
    requireCompleteProfile(req, res, () => {
      requireRoles('user')(req, res, next);
    });
  });
}

/** Patient or physio ? attaches req.jwtPayload only; use authenticateJwt for guards */
export function optionalJwt(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();
  try {
    const token = authHeader.slice('Bearer '.length);
    req.jwtPayload = jwt.verify(token, JWT_SECRET);
  } catch {
    req.jwtPayload = null;
  }
  next();
}
