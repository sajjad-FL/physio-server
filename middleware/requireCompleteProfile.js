/**
 * After authenticateJwt (or any middleware that sets req.auth from JWT).
 * Blocks API access until User.isProfileComplete is true.
 * Admin API key flows (no req.auth) are not blocked.
 */
export function requireCompleteProfile(req, res, next) {
  if (!req.auth) return next();
  if (req.auth.isProfileComplete === true) return next();
  return res.status(403).json({
    message: 'Complete your profile to continue',
    code: 'PROFILE_INCOMPLETE',
  });
}
