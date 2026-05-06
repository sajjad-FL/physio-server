/** Allowed values for `User.gender` (patient + profile PATCH). */
export const PATIENT_GENDERS = new Set(['male', 'female', 'other', 'prefer_not_to_say']);

/** Common UI / locale labels → canonical enum (lowercase keys). */
const GENDER_SYNONYMS = new Map(
  Object.entries({
    woman: 'female',
    women: 'female',
    girl: 'female',
    man: 'male',
    men: 'male',
    boy: 'male',
    m: 'male',
    f: 'female',
    others: 'other',
    unspecified: 'prefer_not_to_say',
    unknown: 'prefer_not_to_say',
  })
);

/**
 * @param {unknown} raw
 * @returns {'' | 'male' | 'female' | 'other' | 'prefer_not_to_say'} canonical enum value, or '' if missing/invalid
 */
export function normalizePatientGender(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (PATIENT_GENDERS.has(s)) return s;
  const lower = s.toLowerCase();
  if (PATIENT_GENDERS.has(lower)) return lower;
  const mapped = GENDER_SYNONYMS.get(lower);
  if (mapped && PATIENT_GENDERS.has(mapped)) return mapped;
  return '';
}
