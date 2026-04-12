import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { createOtp, startOtpCleanupInterval, verifyOtpAttempt } from '../utils/otpStore.js';
import { findUserByNormalizedDigits } from '../utils/physioPhoneLookup.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';
import { normalizeRole } from '../utils/userRole.js';
import { grantPasswordReset, consumePasswordResetGrant } from '../utils/passwordResetGrant.js';
import { parseAddressPayload } from './profileController.js';

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES) || 10;
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;
const DEBUG_OTP = String(process.env.DEBUG_OTP || '').toLowerCase() === 'true';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const OTP_PURPOSE_PASSWORD_RESET = 'password_reset';
const OTP_PURPOSE_DEBUG_LOGIN = 'debug_login';
const OTP_PURPOSE_SIGNUP = 'signup';
const SIGNUP_GENDERS = new Set(['male', 'female', 'other', 'prefer_not_to_say']);
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 8;

if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET is not set; using dev-secret.');
}

startOtpCleanupInterval({ intervalMinutes: 5 });

/** Signup DOB: must be 18–120 years, not in the future (aligns with patient booking validation). */
function parseRegisterDob(input) {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  if (d > now) return null;
  const years = (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 18 || years > 120) return null;
  return d;
}

export function signUserToken(user, physioIdOverride) {
  const physioId =
    physioIdOverride != null ? String(physioIdOverride) : user.physioId?.toString() || undefined;
  const role = normalizeRole(user);
  return jwt.sign(
    {
      userId: user._id.toString(),
      role,
      ...(physioId ? { physioId } : {}),
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

const SIGNUP_OTP_HELP =
  'Request a new code with “Send verification code” if it expired. With DEBUG_OTP=true, the code is returned in the API response and server logs (local dev only).';

/**
 * Send a 6-digit OTP for patient signup (number must not already be registered).
 * Integrate SMS in production; until then use DEBUG_OTP for local testing.
 */
export async function sendSignupOtp(req, res, next) {
  try {
    const pv = validateIndianMobile(req.body?.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message });
    }

    const existing = await User.findOne({ phone: pv.normalized }).select('_id').lean();
    if (existing) {
      return res.status(409).json({ message: 'This phone number is already registered. Sign in instead.' });
    }

    const { phone: normalizedPhone, otp } = createOtp({
      phone: pv.normalized,
      ttlMinutes: OTP_TTL_MINUTES,
      purpose: OTP_PURPOSE_SIGNUP,
    });

    if (DEBUG_OTP) {
      console.log('[debug][signup-otp] ' + normalizedPhone + ' -> ' + otp);
      return res.json({
        message: 'Verification code issued (DEBUG_OTP). Enter it below — in production this would be sent by SMS.',
        otp,
      });
    }

    return res.json({
      message:
        'If SMS is configured, a verification code was sent to this number. Enter it below within a few minutes. ' +
        SIGNUP_OTP_HELP,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Patient signup: phone (verified via OTP) + password + name + DOB + location + gender.
 */
export async function registerPatient(req, res, next) {
  try {
    const pv = validateIndianMobile(req.body?.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message });
    }

    const otpRaw = String(req.body?.otp || '').trim();
    if (!otpRaw) {
      return res.status(400).json({ message: 'Verification code is required. Tap “Send verification code” first.' });
    }
    if (!/^\d{6}$/.test(otpRaw)) {
      return res.status(400).json({ message: 'Verification code must be 6 digits' });
    }

    const otpResult = verifyOtpAttempt({
      phone: pv.normalized,
      otp: otpRaw,
      maxAttempts: OTP_MAX_ATTEMPTS,
      purpose: OTP_PURPOSE_SIGNUP,
    });
    if (!otpResult.ok) {
      if (otpResult.reason === 'locked') {
        return res.status(429).json({ message: 'Too many incorrect attempts. Request a new verification code.' });
      }
      if (otpResult.reason === 'mismatch') {
        return res.status(400).json({ message: 'Incorrect verification code' });
      }
      return res.status(400).json({
        message: 'Code expired or invalid. Request a new verification code.',
      });
    }

    const password = String(req.body?.password || '');
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
    }

    const name = String(req.body?.name || '').trim();
    if (!name || name.length < 2) {
      return res.status(400).json({ message: 'Name is required (at least 2 characters)' });
    }

    const gender = String(req.body?.gender || '').trim();
    if (!SIGNUP_GENDERS.has(gender)) {
      return res.status(400).json({ message: 'Please choose a valid gender' });
    }

    const dob = parseRegisterDob(req.body?.dob);
    if (!dob) {
      return res.status(400).json({
        message: 'Valid date of birth is required (you must be at least 18, not in the future)',
      });
    }

    const addressParsed = parseAddressPayload(req.body);
    if (addressParsed.error) {
      return res.status(400).json({ message: addressParsed.error });
    }
    if (!addressParsed.provided || !String(addressParsed.location || '').trim()) {
      return res.status(400).json({ message: 'City or area (location) is required' });
    }
    const locText = String(addressParsed.location || '').trim();
    if (locText.length < 2) {
      return res.status(400).json({ message: 'Location must be at least 2 characters' });
    }

    const existing = await User.findOne({ phone: pv.normalized }).select('_id').lean();
    if (existing) {
      return res.status(409).json({ message: 'This phone number is already registered' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await User.create({
      phone: pv.normalized,
      name,
      email: '',
      dob,
      gender,
      address: addressParsed.value,
      location: addressParsed.location || '',
      coordinates: addressParsed.coordinates,
      passwordHash,
      hasPasswordLogin: true,
      isVerified: true,
      isProfileComplete: true,
      role: 'user',
    });

    const token = signUserToken(user);
    return res.status(201).json({
      token,
      role: normalizeRole(user),
      isProfileComplete: user.isProfileComplete === true,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: 'This phone number is already registered' });
    }
    next(err);
  }
}

/**
 * Dev only (DEBUG_OTP=true): issue a 6-digit code; paste it as the password on /auth/login.
 */
export async function debugSendLoginOtp(req, res, next) {
  try {
    if (!DEBUG_OTP) {
      return res.status(404).json({ message: 'Not found' });
    }
    const pv = validateIndianMobile(req.body?.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message });
    }
    const linked = await findUserByNormalizedDigits(pv.normalized);
    if (!linked) {
      return res.status(404).json({ message: 'No user found for this phone' });
    }
    const { phone: normalizedPhone, otp } = createOtp({
      phone: pv.normalized,
      ttlMinutes: OTP_TTL_MINUTES,
      purpose: OTP_PURPOSE_DEBUG_LOGIN,
    });
    console.log('[debug][login-otp] ' + normalizedPhone + ' -> ' + otp);
    return res.json({
      message: 'Use this 6-digit code as your password on the login form (DEBUG_OTP only).',
      otp,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Login: phone + password. When DEBUG_OTP=true, a 6-digit code from POST /auth/debug-login-otp also works (for users without password or quick local testing).
 */
export async function loginWithPassword(req, res, next) {
  try {
    const pv = validateIndianMobile(req.body?.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message });
    }
    const password = String(req.body?.password || '');
    if (!password) {
      return res.status(400).json({ message: 'Password is required' });
    }

    if (DEBUG_OTP && /^\d{6}$/.test(password)) {
      const otpResult = verifyOtpAttempt({
        phone: pv.normalized,
        otp: password,
        maxAttempts: OTP_MAX_ATTEMPTS,
        purpose: OTP_PURPOSE_DEBUG_LOGIN,
      });
      if (otpResult.ok) {
        const linked = await findUserByNormalizedDigits(otpResult.phone);
        if (!linked) {
          return res.status(401).json({ message: 'Invalid phone or code' });
        }
        const user = await User.findById(linked._id);
        if (!user) {
          return res.status(401).json({ message: 'Invalid phone or code' });
        }
        const token = signUserToken(user);
        return res.json({
          token,
          role: normalizeRole(user),
          isProfileComplete: user.isProfileComplete === true,
        });
      }
    }

    const user = await User.findOne({ phone: pv.normalized }).select('+passwordHash');
    if (!user) {
      return res.status(401).json({
        code: 'LOGIN_NO_ACCOUNT',
        message:
          'No account is registered with this mobile number. Create an account first, then sign in here with the same number and password.',
      });
    }

    if (!user.passwordHash) {
      return res.status(401).json({
        code: 'LOGIN_PASSWORD_NOT_SET',
        message:
          'This number is already on file, but no sign-in password was set yet (for example, an older OTP-only signup). Use Forgot password to choose a password, then sign in.' +
          (DEBUG_OTP
            ? ' With DEBUG_OTP enabled, you can use POST /auth/debug-login-otp for a 6-digit code and enter it as the password (local dev only).'
            : ''),
      });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({
        code: 'LOGIN_WRONG_PASSWORD',
        message: 'That password doesn’t match this number. Try again, or use Forgot password if you’re unsure.',
      });
    }

    const token = signUserToken(user);
    return res.json({
      token,
      role: normalizeRole(user),
      isProfileComplete: user.isProfileComplete === true,
    });
  } catch (err) {
    next(err);
  }
}

const GENERIC_FORGOT_MSG = 'If an account exists for this number, a verification code has been sent.';

/**
 * Send OTP for password reset (user must exist).
 */
export async function forgotPassword(req, res, next) {
  try {
    const pv = validateIndianMobile(req.body?.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message });
    }

    const user = await findUserByNormalizedDigits(pv.normalized);
    if (!user) {
      return res.json({ message: GENERIC_FORGOT_MSG });
    }

    const { phone: normalizedPhone, otp } = createOtp({
      phone: pv.normalized,
      ttlMinutes: OTP_TTL_MINUTES,
      purpose: OTP_PURPOSE_PASSWORD_RESET,
    });

    if (DEBUG_OTP) {
      console.log('[debug][forgot-password-otp] ' + normalizedPhone + ' -> ' + otp);
      return res.json({ message: GENERIC_FORGOT_MSG, otp });
    }

    return res.json({ message: GENERIC_FORGOT_MSG });
  } catch (err) {
    next(err);
  }
}

/**
 * Verify OTP for password reset (does not log in). Next step: POST /auth/reset-password
 */
export async function verifyPasswordResetOtp(req, res, next) {
  try {
    const otp = String(req.body?.otp || '').trim();
    const pv = validateIndianMobile(req.body?.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message });
    }
    if (!otp) {
      return res.status(400).json({ message: 'OTP is required' });
    }
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: 'OTP must be 6 digits' });
    }

    const result = verifyOtpAttempt({
      phone: pv.normalized,
      otp,
      maxAttempts: OTP_MAX_ATTEMPTS,
      purpose: OTP_PURPOSE_PASSWORD_RESET,
    });

    if (!result.ok) {
      if (result.reason === 'locked') {
        return res.status(429).json({ message: 'Too many attempts. Please request a new code.' });
      }
      if (result.reason === 'mismatch') {
        return res.status(400).json({ message: 'Incorrect code' });
      }
      return res.status(400).json({ message: 'Code expired or invalid. Please request a new one.' });
    }

    const user = await findUserByNormalizedDigits(result.phone);
    if (!user) {
      return res.status(400).json({ message: 'No account found for this number' });
    }

    grantPasswordReset(result.phone);
    return res.json({ message: 'Code verified. You can set a new password.' });
  } catch (err) {
    next(err);
  }
}

/**
 * Set new password after successful verify-password-reset OTP.
 */
export async function resetPassword(req, res, next) {
  try {
    const pv = validateIndianMobile(req.body?.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message });
    }
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
    }

    if (!consumePasswordResetGrant(pv.normalized)) {
      return res.status(400).json({
        message: 'Reset session expired or invalid. Verify your code again from the start.',
      });
    }

    const user = await User.findOne({ phone: pv.normalized });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.hasPasswordLogin = true;
    user.isVerified = true;
    await user.save();

    return res.json({ message: 'Password updated. You can sign in with your new password.' });
  } catch (err) {
    next(err);
  }
}
