import crypto from 'node:crypto';
import mongoose from 'mongoose';

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const MAX_ATTEMPTS = 8;

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CHARSET[bytes[i] % CHARSET.length];
  }
  return out;
}

export function normalizeReferralCodeInput(raw) {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Generate a unique referral code (uppercase alphanumeric, 6 chars). */
export async function generateUniqueReferralCode() {
  const User = mongoose.models.User || (await import('../models/User.js')).default;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = randomCode();
    const exists = await User.exists({ referralCode: code });
    if (!exists) return code;
  }
  const err = new Error('Could not generate unique referral code');
  err.statusCode = 500;
  throw err;
}
