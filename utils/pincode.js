/** Extract 6-digit Indian pincode from free-text location or address. */
export function extractPincode(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

export function normalizePincode(input) {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  if (/^\d{6}$/.test(s)) return s;
  return extractPincode(s);
}
