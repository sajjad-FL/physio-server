import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { normalizeIndianPhone } from './phoneIndia.js';

/**
 * Legacy stored formats (pre-normalization migration).
 * @param {string} last10
 */
function legacyPhoneOrQuery(last10) {
  const variants = [
    last10,
    `91${last10}`,
    `0${last10}`,
    `+91${last10}`,
    `+91 ${last10}`,
    `+91-${last10}`,
    `0091${last10}`,
  ];
  return { $or: variants.map((phone) => ({ phone })) };
}

/**
 * Find Physiotherapist by normalized 10-digit mobile, with legacy format fallback.
 * @param {string} digits — raw or normalized input
 */
export async function findPhysioByNormalizedDigits(digits) {
  const n = normalizeIndianPhone(digits);
  if (!n || n.length !== 10) return null;

  let p = await Physiotherapist.findOne({ phone: n }).lean();
  if (p) return p;

  const last10 = n;
  p = await Physiotherapist.findOne(legacyPhoneOrQuery(last10)).lean();
  if (p) return p;

  const suffixRegex = new RegExp(`${last10.split('').join('\\D*')}$`);
  return Physiotherapist.findOne({ phone: { $regex: suffixRegex } }).lean();
}

/**
 * Find User by normalized 10-digit mobile, with legacy format fallback.
 * @param {string} digits
 */
export async function findUserByNormalizedDigits(digits) {
  const n = normalizeIndianPhone(digits);
  if (!n || n.length !== 10) return null;

  let u = await User.findOne({ phone: n });
  if (u) return u;

  const last10 = n;
  u = await User.findOne(legacyPhoneOrQuery(last10));
  if (u) return u;

  const suffixRegex = new RegExp(`${last10.split('').join('\\D*')}$`);
  return User.findOne({ phone: { $regex: suffixRegex } });
}
