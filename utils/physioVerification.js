/** @param {Record<string, unknown> | null | undefined} p */
export function isPhysioBookable(p) {
  if (!p) return false;
  if (p.availability === false || p.isAvailable === false) return false;
  if (!p.isVerified) return false;
  const nested = p.verification?.status;
  if (nested === 'rejected' || nested === 'pending') return false;
  if (nested === 'verified') return true;
  return p.verificationStatus === 'approved';
}

/** @param {Record<string, unknown>} p */
export function displayVerificationStatus(p) {
  const nested = p.verification?.status;
  if (nested === 'verified' || nested === 'rejected' || nested === 'pending') return nested;
  if (p.verificationStatus === 'approved') return 'verified';
  if (p.verificationStatus === 'rejected') return 'rejected';
  return 'pending';
}

/** Badge tier for UI: basic | verified | premium */
export function verificationBadgeLevel(p) {
  const level = p.verification?.level;
  if (level === 'premium' || level === 'verified' || level === 'basic') return level;
  return 'basic';
}
