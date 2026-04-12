/**
 * Require a matching role. Users with role `admin` may access all routes (hierarchy).
 */
export function requireRoles(...allowed) {
  return (req, res, next) => {
    const role = req.auth?.role;
    if (role === 'admin') {
      return next();
    }
    const ok = allowed.includes(role);
    if (!ok) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };
}
