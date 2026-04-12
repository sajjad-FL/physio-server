const VALID = new Set(['user', 'physio', 'admin']);

/**
 * Single role per user. Reads `user.role`, or derives from legacy `roles[]` until migrated.
 * @param {{ role?: string, roles?: string[] } | null | undefined} user
 * @returns {'user' | 'physio' | 'admin'}
 */
export function normalizeRole(user) {
  if (!user) return 'user';
  if (VALID.has(user.role)) return user.role;
  const arr = Array.isArray(user.roles) ? user.roles : [];
  if (arr.includes('admin')) return 'admin';
  if (arr.includes('physio')) return 'physio';
  return 'user';
}
