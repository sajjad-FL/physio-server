const VALID = new Set(['user', 'physio', 'admin', 'care_manager']);

/**
 * Single role per user. Reads `user.role`, or derives from legacy `roles[]` until migrated.
 * @param {{ role?: string, roles?: string[] } | null | undefined} user
 * @returns {'user' | 'physio' | 'admin' | 'care_manager'}
 */
export function normalizeRole(user) {
  if (!user) return 'user';
  if (VALID.has(user.role)) return user.role;
  const arr = Array.isArray(user.roles) ? user.roles : [];
  if (arr.includes('admin')) return 'admin';
  if (arr.includes('care_manager')) return 'care_manager';
  if (arr.includes('physio')) return 'physio';
  return 'user';
}
