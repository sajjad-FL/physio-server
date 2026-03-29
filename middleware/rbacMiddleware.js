/**
 * Require at least one of the given roles.
 * Users with role `admin` may access all routes (hierarchy).
 */
export function requireRoles(...allowed) {
  return (req, res, next) => {
    const roles = req.auth?.roles || [];
    if (roles.includes('admin')) {
      return next();
    }
    const ok = allowed.some((r) => roles.includes(r));
    if (!ok) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };
}
