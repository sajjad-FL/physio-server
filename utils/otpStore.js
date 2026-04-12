import { normalizeIndianPhone } from './phoneIndia.js';

const store = new Map();

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function now() {
  return Date.now();
}

function storeKey(purpose, normalizedPhone) {
  return `${purpose}:${normalizedPhone}`;
}

/**
 * @param {{ phone: string, ttlMinutes: number, purpose?: string }} opts
 * purpose e.g. 'password_reset' — isolates OTP from other flows
 */
export function createOtp({ phone, ttlMinutes, purpose = 'default' }) {
  const normalized = normalizeIndianPhone(phone);
  const otp = generateOtp();
  const key = storeKey(purpose, normalized);
  store.set(key, {
    otp,
    expiresAt: now() + Number(ttlMinutes) * 60 * 1000,
    attempts: 0,
  });
  return { phone: normalized, otp };
}

/**
 * @param {{ phone: string, otp: string, maxAttempts: number, purpose?: string }} opts
 */
export function verifyOtpAttempt({ phone, otp, maxAttempts, purpose = 'default' }) {
  const normalized = normalizeIndianPhone(phone);
  const key = storeKey(purpose, normalized);
  const record = store.get(key);
  if (!record) return { ok: false, reason: 'missing' };

  if (now() > record.expiresAt) {
    store.delete(key);
    return { ok: false, reason: 'expired' };
  }

  if (record.attempts >= maxAttempts) {
    store.delete(key);
    return { ok: false, reason: 'locked' };
  }

  if (record.otp !== String(otp)) {
    record.attempts += 1;
    store.set(key, record);
    if (record.attempts >= maxAttempts) {
      store.delete(key);
      return { ok: false, reason: 'locked' };
    }
    return { ok: false, reason: 'mismatch' };
  }

  store.delete(key);
  return { ok: true, phone: normalized };
}

export function cleanupExpired() {
  const ts = now();
  for (const [key, record] of store.entries()) {
    if (ts > record.expiresAt) store.delete(key);
  }
}

export function startOtpCleanupInterval({ intervalMinutes = 5 } = {}) {
  const ms = Number(intervalMinutes) * 60 * 1000;
  const id = setInterval(() => cleanupExpired(), ms);
  id.unref?.();
  return id;
}

export function _normalizePhoneForTests(phone) {
  return normalizeIndianPhone(phone);
}
