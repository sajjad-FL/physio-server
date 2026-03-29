import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { createOtp, startOtpCleanupInterval, verifyOtpAttempt } from '../utils/otpStore.js';

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES) || 10;
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;
const DEBUG_OTP = true;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET is not set; using dev-secret.');
}

startOtpCleanupInterval({ intervalMinutes: 5 });

function mergeRoles(existing, additions) {
  const set = new Set([...(Array.isArray(existing) ? existing : []), ...additions]);
  return Array.from(set);
}

function signUserToken(user, physioIdOverride) {
  const physioId =
    physioIdOverride != null ? String(physioIdOverride) : user.physioId?.toString() || undefined;
  return jwt.sign(
    {
      userId: user._id.toString(),
      roles: user.roles,
      ...(physioId ? { physioId } : {}),
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export async function sendOtp(req, res, next) {
  try {
    const phone = String(req.body?.phone || '');
    const { phone: normalizedPhone, otp } = createOtp({ phone, ttlMinutes: OTP_TTL_MINUTES });

    if (!normalizedPhone || normalizedPhone.length < 10) {
      return res.status(400).json({ message: 'Valid phone is required' });
    }

    const physio = await Physiotherapist.findOne({ phone: normalizedPhone }).lean();
    if (!physio) {
      await User.findOneAndUpdate(
        { phone: normalizedPhone },
        { $set: { phone: normalizedPhone }, $setOnInsert: { isVerified: false, roles: ['user'] } },
        { upsert: true, new: true }
      );
    }

    if (DEBUG_OTP) {
      console.log('[debug][otp] ' + normalizedPhone + ' -> ' + otp);
      return res.json({ message: 'OTP sent', otp });
    }

    return res.json({ message: 'OTP sent' });
  } catch (err) {
    next(err);
  }
}

export async function verifyOtp(req, res, next) {
  try {
    const phone = String(req.body?.phone || '');
    const otp = String(req.body?.otp || '').trim();

    if (!phone || !otp) {
      return res.status(400).json({ message: 'Phone and OTP are required' });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: 'OTP must be 6 digits' });
    }

    const result = verifyOtpAttempt({ phone, otp, maxAttempts: OTP_MAX_ATTEMPTS });
    if (!result.ok) {
      if (result.reason === 'locked') {
        return res.status(429).json({ message: 'Too many attempts. Please resend.' });
      }
      if (result.reason === 'mismatch') {
        return res.status(400).json({ message: 'Incorrect OTP' });
      }
      return res.status(400).json({ message: 'OTP expired. Please resend.' });
    }

    const normalizedPhone = result.phone;

    const physio = await Physiotherapist.findOne({ phone: normalizedPhone });
    if (physio) {
      let user = await User.findOne({ phone: normalizedPhone });
      if (!user) {
        user = await User.create({
          phone: normalizedPhone,
          name: physio.name,
          location: physio.location,
          isVerified: true,
          roles: mergeRoles([], ['user', 'physio']),
          physioId: physio._id,
        });
      } else {
        user.isVerified = true;
        user.roles = mergeRoles(user.roles, ['user', 'physio']);
        user.physioId = physio._id;
        if (!user.name) user.name = physio.name;
        await user.save();
      }

      const token = signUserToken(user, physio._id);
      return res.json({
        token,
        roles: user.roles,
        role: 'physio',
        isProfileComplete: user.isProfileComplete === true,
      });
    }

    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    user.isVerified = true;
    if (!user.roles || user.roles.length === 0) {
      user.roles = ['user'];
    } else if (!user.roles.includes('user')) {
      user.roles = mergeRoles(user.roles, ['user']);
    }
    await user.save();

    const token = signUserToken(user);
    return res.json({
      token,
      roles: user.roles,
      role: 'patient',
      isProfileComplete: user.isProfileComplete === true,
    });
  } catch (err) {
    next(err);
  }
}
