export const ID_PROOF_TYPE_VALUES = Object.freeze(['aadhaar', 'pan', 'passport', 'voter_id']);

export function isValidIdProofType(v) {
  return ID_PROOF_TYPE_VALUES.includes(String(v ?? '').trim().toLowerCase());
}
