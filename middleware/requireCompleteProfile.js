/**
 * After authenticateJwt (or any middleware that sets req.auth from JWT).
 * Blocks patient (`role=user`) API access until User.isProfileComplete is true.
 * Physios have a separate onboarding/approval gate and should not be blocked here.
 * Admin API key flows (no req.auth) are not blocked.
 */
export function requireCompleteProfile(req, res, next) {
  if (!req.auth) return next();
  if (req.auth.role && req.auth.role !== 'user') return next();
  if (req.auth.isProfileComplete === true) return next();
  return res.status(403).json({
    message: 'Complete your profile to continue',
    code: 'PROFILE_INCOMPLETE',
  });
}
