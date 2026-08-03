/** Allowed spoken languages for physiotherapist profiles (NE India focus). */
export const PHYSIO_LANGUAGE_VALUES = Object.freeze([
  'Hindi',
  'English',
  'Assamese',
  'Bodo',
  'Bengali',
  'Manipuri (Meitei)',
  'Mizo',
  'Khasi',
  'Garo',
  'Nagamese',
  'Nepali',
  'Karbi',
  'Dimasa',
  'Kokborok',
  'Ao',
  'Angami',
]);

export function isValidPhysioLanguage(v) {
  return PHYSIO_LANGUAGE_VALUES.includes(String(v ?? '').trim());
}

/**
 * @param {unknown} input
 * @returns {string[]}
 */
export function parsePhysioLanguages(input) {
  let list = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
      else list = raw.split(/[,;]/);
    } catch {
      list = raw.split(/[,;]/);
    }
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = String(item ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
