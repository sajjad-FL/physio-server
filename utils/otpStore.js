const store = new Map();

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function now() {
  return Date.now();
}

export function createOtp({ phone, ttlMinutes }) {
  const normalized = normalizePhone(phone);
  const otp = generateOtp();
  store.set(normalized, {
    otp,
    expiresAt: now() + Number(ttlMinutes) * 60 * 1000,
    attempts: 0,
  });
  return { phone: normalized, otp };
}

export function verifyOtpAttempt({ phone, otp, maxAttempts }) {
  const normalized = normalizePhone(phone);
  const record = store.get(normalized);
  if (!record) return { ok: false, reason: 'missing' };

  if (now() > record.expiresAt) {
    store.delete(normalized);
    return { ok: false, reason: 'expired' };
  }

  if (record.attempts >= maxAttempts) {
    store.delete(normalized);
    return { ok: false, reason: 'locked' };
  }

  if (record.otp !== String(otp)) {
    record.attempts += 1;
    store.set(normalized, record);
    if (record.attempts >= maxAttempts) {
      store.delete(normalized);
      return { ok: false, reason: 'locked' };
    }
    return { ok: false, reason: 'mismatch' };
  }

  store.delete(normalized);
  return { ok: true, phone: normalized };
}

export function cleanupExpired() {
  const ts = now();
  for (const [phone, record] of store.entries()) {
    if (ts > record.expiresAt) store.delete(phone);
  }
}

export function startOtpCleanupInterval({ intervalMinutes = 5 } = {}) {
  const ms = Number(intervalMinutes) * 60 * 1000;
  const id = setInterval(() => cleanupExpired(), ms);
  // allow process to exit
  id.unref?.();
  return id;
}

export function _normalizePhoneForTests(phone) {
  return normalizePhone(phone);
}

