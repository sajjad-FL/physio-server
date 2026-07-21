import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 6;

export class CreatePatientError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CreatePatientError';
    this.status = status;
  }
}

/**
 * Create a normal patient account (role user) without WhatsApp OTP.
 * Same end-state as minimal self-registration; staff verifies identity in person.
 */
export async function createPatientUser({ phone, name, password, registeredByClinicId = null } = {}) {
  const pv = validateIndianMobile(phone);
  if (!pv.valid) {
    throw new CreatePatientError(400, pv.message);
  }

  const passwordStr = String(password || '');
  if (passwordStr.length < MIN_PASSWORD_LEN) {
    throw new CreatePatientError(400, `Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }

  const nameStr = String(name || '').trim();
  if (!nameStr || nameStr.length < 2) {
    throw new CreatePatientError(400, 'Name is required (at least 2 characters)');
  }

  const existing = await User.findOne({ phone: pv.normalized }).select('_id').lean();
  if (existing) {
    throw new CreatePatientError(409, 'This phone number is already registered');
  }

  const passwordHash = await bcrypt.hash(passwordStr, BCRYPT_ROUNDS);
  const clinicRef =
    registeredByClinicId && mongoose.isValidObjectId(registeredByClinicId)
      ? registeredByClinicId
      : null;

  try {
    const user = await User.create({
      phone: pv.normalized,
      name: nameStr,
      email: '',
      dob: null,
      gender: 'prefer_not_to_say',
      address: { text: '', lat: null, lng: null },
      location: '',
      coordinates: null,
      passwordHash,
      hasPasswordLogin: true,
      isVerified: true,
      isProfileComplete: false,
      role: 'user',
      ...(clinicRef ? { registeredByClinicId: clinicRef } : {}),
    });

    return {
      _id: user._id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      isProfileComplete: user.isProfileComplete === true,
      registeredByClinicId: user.registeredByClinicId || null,
    };
  } catch (err) {
    if (err?.code === 11000) {
      throw new CreatePatientError(409, 'This phone number is already registered');
    }
    throw err;
  }
}
