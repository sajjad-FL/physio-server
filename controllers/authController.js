import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { createOtp, startOtpCleanupInterval, verifyOtpAttempt, consumeOtp } from '../utils/otpStore.js';
import { findUserByNormalizedDigits } from '../utils/physioPhoneLookup.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';
import { normalizeRole } from '../utils/userRole.js';
import { grantPasswordReset, consumePasswordResetGrant } from '../utils/passwordResetGrant.js';
import { parseAddressPayload } from './profileController.js';
import { normalizePatientGender } from '../utils/patientGender.js';
import { normalizeReferralCodeInput } from '../utils/referralCode.js';
import { processReferralSignupBonus } from '../services/referralSignupBonus.js';
import { sendAuthKeyOtp, isAuthKeyConfigured } from '../utils/authKeyOtp.js';
import { OTP_LENGTH, OTP_REGEX } from '../constants/otp.js';

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES) || 10;
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;
const DEBUG_OTP = String(process.env.DEBUG_OTP || '').toLowerCase() === 'true';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const OTP_PURPOSE_PASSWORD_RESET = 'password_reset';
const OTP_PURPOSE_DEBUG_LOGIN = 'debug_login';
const OTP_PURPOSE_SIGNUP = 'signup';
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 6;

if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET is not set; using dev-secret.');
}

startOtpCleanupInterval({ intervalMinutes: 5 });

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
    { expiresIn: '7d' },
  );
}

function buildOtpSendResponse(message, otp) {
  if (DEBUG_OTP) {
    return { message, otp };
  }
  return { message };
}

/** All OTP sends (signup + forgot-password) go through Fast2SMS WhatsApp. */
async function deliverOtpWhatsApp(normalizedPhone, otp, logLabel) {
  if (DEBUG_OTP) {
    console.log(`[debug][${logLabel}] ${normalizedPhone} -> ${otp}`);
    return;
  }
  if (!isAuthKeyConfigured()) {
    throw new Error('WhatsApp OTP is not configured on this server.');
  }
  await sendAuthKeyOtp({ mobile: normalizedPhone, otp });
}

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

    try {
      await deliverOtpWhatsApp(normalizedPhone, otp, 'signup-otp');
    } catch (e) {
      return res.status(502).json({ message: e.message || 'Could not send verification code' });
    }

    const message = DEBUG_OTP
      ? `Verification code issued (DEBUG_OTP). Enter the ${OTP_LENGTH}-digit code below.`
      : `A ${OTP_LENGTH}-digit verification code was sent via WhatsApp. Enter it below within a few minutes.`;

    return res.json(buildOtpSendResponse(message, otp));
  } catch (err) {
    next(err);
  }
}

export async function registerPatient(req, res, next) {
  try {
    const pv = validateIndianMobile(req.body?.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message });
    }

    const otpRaw = String(req.body?.otp || '').trim();
    if (!otpRaw) {
      return res.status(400).json({ message: 'Verification code is required. Request a code first.' });
    }
    if (!OTP_REGEX.test(otpRaw)) {
      return res.status(400).json({ message: `Verification code must be ${OTP_LENGTH} digits` });
    }

    const otpResult = verifyOtpAttempt({
      phone: pv.normalized,
      otp: otpRaw,
      maxAttempts: OTP_MAX_ATTEMPTS,
      purpose: OTP_PURPOSE_SIGNUP,
      // Keep OTP until account is created — referral / other checks may still fail.
      consume: false,
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

    const dobRaw = req.body?.dob;
    const addressParsed = parseAddressPayload(req.body);
    const genderNormalized = normalizePatientGender(req.body?.gender);
    const hasGenderInput = Boolean(genderNormalized);
    const dobParsed = parseRegisterDob(dobRaw);
    const hasValidDobInput = dobParsed != null;
    const hasLocationInput =
      addressParsed.provided && String(addressParsed.location || '').trim().length >= 2;

    const profileParts = [hasValidDobInput, hasGenderInput, hasLocationInput].filter(Boolean).length;
    if (profileParts !== 0 && profileParts !== 3) {
      return res.status(400).json({
        message:
          'Send date of birth, gender, and location all together on signup, or leave all three out and add them in your profile later.',
      });
    }

    const wantsFullProfile = profileParts === 3;
    let dob;
    let locText;
    let addressValue;
    let coordinates;
    let isProfileComplete;

    if (wantsFullProfile) {
      dob = dobParsed;
      if (addressParsed.error) {
        return res.status(400).json({ message: addressParsed.error });
      }
      if (!addressParsed.provided || !String(addressParsed.location || '').trim()) {
        return res.status(400).json({ message: 'City or area (location) is required' });
      }
      locText = String(addressParsed.location || '').trim();
      if (locText.length < 2) {
        return res.status(400).json({ message: 'Location must be at least 2 characters' });
      }
      addressValue = addressParsed.value;
      coordinates = addressParsed.coordinates;
      isProfileComplete = true;
    } else {
      dob = null;
      locText = '';
      addressValue = { text: '', lat: null, lng: null };
      coordinates = null;
      isProfileComplete = false;
    }

    const existing = await User.findOne({ phone: pv.normalized }).select('_id').lean();
    if (existing) {
      return res.status(409).json({ message: 'This phone number is already registered' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const genderToSave = wantsFullProfile ? genderNormalized : 'prefer_not_to_say';

    let referredBy = null;
    const referralCodeRaw = normalizeReferralCodeInput(req.body?.referralCode);
    if (referralCodeRaw) {
      const referrer = await User.findOne({ referralCode: referralCodeRaw, role: 'user' })
        .select('_id phone')
        .lean();
      if (!referrer) {
        return res.status(400).json({
          message:
            "We couldn't find that referral code. Double-check it, or leave the field blank to continue.",
          field: 'referralCode',
        });
      }
      if (referrer.phone === pv.normalized) {
        return res.status(400).json({
          message: "You can't use your own referral code. Ask a friend for theirs, or leave it blank.",
          field: 'referralCode',
        });
      }
      referredBy = referrer._id;
    }

    const user = await User.create({
      phone: pv.normalized,
      name,
      email: '',
      dob,
      gender: genderToSave,
      address: addressValue,
      location: locText,
      coordinates,
      passwordHash,
      hasPasswordLogin: true,
      isVerified: true,
      isProfileComplete,
      role: 'user',
      ...(referredBy ? { referredBy } : {}),
    });

    consumeOtp({ phone: pv.normalized, purpose: OTP_PURPOSE_SIGNUP });

    let referralSignupBonusCredited = 0;
    if (referredBy) {
      try {
        const bonusResult = await processReferralSignupBonus(user);
        if (bonusResult.processed && bonusResult.amount > 0) {
          referralSignupBonusCredited = bonusResult.amount;
        }
      } catch (e) {
        console.warn('[referral] signup bonus:', e?.message || e);
      }
    }

    const token = signUserToken(user);
    return res.status(201).json({
      token,
      role: normalizeRole(user),
      isProfileComplete: user.isProfileComplete === true,
      ...(referralSignupBonusCredited > 0 ? { referralSignupBonusCredited } : {}),
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: 'This phone number is already registered' });
    }
    next(err);
  }
}

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
      message: `Use this ${OTP_LENGTH}-digit code as your password on the login form (DEBUG_OTP only).`,
      otp,
    });
  } catch (err) {
    next(err);
  }
}

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

    if (DEBUG_OTP && OTP_REGEX.test(password)) {
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
          'This number is already on file, but no sign-in password was set yet. Use Forgot password to choose a password, then sign in.' +
          (DEBUG_OTP
            ? ` With DEBUG_OTP enabled, you can use POST /auth/debug-login-otp for a ${OTP_LENGTH}-digit code and enter it as the password (local dev only).`
            : ''),
      });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({
        code: 'LOGIN_WRONG_PASSWORD',
        message: "That password doesn't match this number. Try again, or use Forgot password if you're unsure.",
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

const GENERIC_FORGOT_MSG =
  'If an account exists for this number, a verification code has been sent via WhatsApp.';

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

    try {
      await deliverOtpWhatsApp(normalizedPhone, otp, 'forgot-password-otp');
    } catch (e) {
      return res.status(502).json({ message: e.message || 'Could not send verification code' });
    }

    return res.json(buildOtpSendResponse(GENERIC_FORGOT_MSG, otp));
  } catch (err) {
    next(err);
  }
}

export async function verifyPasswordResetOtp(req, res, next) {
  try {
    const otp = String(req.body?.otp || '').trim();
    const pv = validateIndianMobile(req.body?.phone);
    if (!pv.valid) {
      return res.status(400).json({ message: pv.message });
    }
    if (!otp) return res.status(400).json({ message: 'OTP is required' });
    if (!OTP_REGEX.test(otp)) {
      return res.status(400).json({ message: `OTP must be ${OTP_LENGTH} digits` });
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
