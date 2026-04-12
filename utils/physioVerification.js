/**
 * Approved for marketplace + physio portal (not pending/rejected).
 * @param {Record<string, unknown> | null | undefined} p
 */
export function isPhysioPlatformApproved(p) {
  if (!p) return false;
  if (!p.isVerified) return false;
  if (p.verificationStatus === 'rejected') return false;
  if (p.verificationStatus !== 'approved') return false;
  const nested = p.verification?.status;
  if (nested === 'rejected') return false;
  if (nested === 'pending') return false;
  if (nested === 'verified') return true;
  return !nested;
}

/**
 * Onboarding PATCH/upload/submit must not run after admin verification.
 * Uses platform-approved check plus explicit verification fields so edge-case
 * records cannot edit or re-submit after verification.
 * @param {Record<string, unknown> | null | undefined} p
 */
export function isPhysioOnboardingLocked(p) {
  if (!p) return false;
  if (isPhysioPlatformApproved(p)) return true;
  if (p.verificationStatus === 'approved') return true;
  if (p.verification?.status === 'verified') return true;
  if (p.verification?.level === 'verified') return true;
  return false;
}

/** @param {Record<string, unknown> | null | undefined} p */
export function isPhysioBookable(p) {
  if (!p) return false;
  if (p.availability === false || p.isAvailable === false) return false;
  if (!isPhysioPlatformApproved(p)) return false;
  return true;
}

/** @param {Record<string, unknown>} p */
export function displayVerificationStatus(p) {
  const nested = p.verification?.status;
  if (nested === 'verified' || nested === 'rejected' || nested === 'pending') return nested;
  if (p.verificationStatus === 'approved') return 'verified';
  if (p.verificationStatus === 'rejected') return 'rejected';
  return 'pending';
}

/**
 * For patient-facing lists: only show a badge when the physio is approved for booking.
 * @param {Record<string, unknown> | null | undefined} p
 * @returns {'verified' | null}
 */
export function verificationBadgeLevel(p) {
  if (!isPhysioPlatformApproved(p)) return null;
  return 'verified';
}
