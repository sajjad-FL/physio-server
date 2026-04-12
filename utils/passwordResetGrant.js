import { normalizeIndianPhone } from './phoneIndia.js';

/** @type {Map<string, number>} normalized phone -> expiry timestamp ms */
const grants = new Map();

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export function grantPasswordReset(phone, ttlMs = DEFAULT_TTL_MS) {
  const k = normalizeIndianPhone(phone);
  grants.set(k, Date.now() + ttlMs);
}

export function consumePasswordResetGrant(phone) {
  const k = normalizeIndianPhone(phone);
  const exp = grants.get(k);
  if (!exp || Date.now() > exp) {
    grants.delete(k);
    return false;
  }
  grants.delete(k);
  return true;
}

export function hasPasswordResetGrant(phone) {
  const k = normalizeIndianPhone(phone);
  const exp = grants.get(k);
  if (!exp || Date.now() > exp) {
    grants.delete(k);
    return false;
  }
  return true;
}
