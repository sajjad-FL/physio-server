const VALID = new Set(['user', 'physio', 'admin', 'care_manager', 'clinic_staff']);

/**
 * Single role per user. Reads `user.role`, or derives from legacy `roles[]` until migrated.
 * @param {{ role?: string, roles?: string[] } | null | undefined} user
 * @returns {'user' | 'physio' | 'admin' | 'care_manager' | 'clinic_staff'}
 */
export function normalizeRole(user) {
  if (!user) return 'user';
  const arr = Array.isArray(user.roles) ? user.roles : [];
  if (user.role === 'admin' || arr.includes('admin')) return 'admin';
  if (user.role === 'care_manager' || arr.includes('care_manager')) return 'care_manager';
  if (user.role === 'clinic_staff' || arr.includes('clinic_staff')) return 'clinic_staff';
  if (user.role === 'physio' || arr.includes('physio')) return 'physio';
  if (VALID.has(user.role)) return user.role;
  return 'user';
}
