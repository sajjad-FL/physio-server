import { resolveAuthFromBearer } from '../utils/authResolve.js';

/**
 * Verifies JWT, loads User roles from DB, sets req.auth and req.user.
 */
export async function authenticateJwt(req, res, next) {
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

    req.auth = ctx;
    req.user = { id: ctx.userId, phone: ctx.phone, roles: ctx.roles };
    next();
  } catch {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}
