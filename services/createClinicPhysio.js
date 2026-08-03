import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Clinic from '../models/Clinic.js';
import Physiotherapist from '../models/Physiotherapist.js';
import User from '../models/User.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 6;

export class CreateClinicPhysioError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CreateClinicPhysioError';
    this.status = status;
  }
}

/**
 * Create an approved clinic-owned physiotherapist + linked User login,
 * and add them to Clinic.physioIds.
 *
 * @param {{
 *   clinic: { _id: import('mongoose').Types.ObjectId, name?: string, address?: string, coordinates?: { lat: number, lng: number } | null },
 *   name: string,
 *   phone: string,
 *   password: string,
 *   specialization: string,
 * }} opts
 */
export async function createClinicPhysio({ clinic, name, phone, password, specialization } = {}) {
  if (!clinic?._id || !mongoose.isValidObjectId(clinic._id)) {
    throw new CreateClinicPhysioError(400, 'Invalid clinic');
  }

  const nameStr = String(name || '').trim();
  if (!nameStr || nameStr.length < 2) {
    throw new CreateClinicPhysioError(400, 'Name is required (at least 2 characters)');
  }

  const spec = String(specialization || '').trim();
  if (!spec || spec.length < 2) {
    throw new CreateClinicPhysioError(400, 'Specialization is required');
  }

  const passwordStr = String(password || '');
  if (passwordStr.length < MIN_PASSWORD_LEN) {
    throw new CreateClinicPhysioError(400, `Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }

  const pv = validateIndianMobile(phone);
  if (!pv.valid) {
    throw new CreateClinicPhysioError(400, pv.message);
  }

  const phoneTakenUser = await User.findOne({ phone: pv.normalized }).select('_id').lean();
  if (phoneTakenUser) {
    throw new CreateClinicPhysioError(409, 'This phone number is already registered');
  }
  const phoneTakenPhysio = await Physiotherapist.findOne({ phone: pv.normalized }).select('_id').lean();
  if (phoneTakenPhysio) {
    throw new CreateClinicPhysioError(409, 'A physiotherapist with this phone already exists');
  }

  const location =
    String(clinic.address || '').trim() ||
    String(clinic.name || '').trim() ||
    'Clinic';
  const coordinates =
    clinic.coordinates &&
    Number.isFinite(Number(clinic.coordinates.lat)) &&
    Number.isFinite(Number(clinic.coordinates.lng))
      ? { lat: Number(clinic.coordinates.lat), lng: Number(clinic.coordinates.lng) }
      : null;

  const passwordHash = await bcrypt.hash(passwordStr, BCRYPT_ROUNDS);

  let physio;
  try {
    physio = await Physiotherapist.create({
      name: nameStr,
      phone: pv.normalized,
      specialization: spec,
      location,
      coordinates,
      clinicId: clinic._id,
      availability: true,
      isAvailable: true,
      experience: 0,
      pricePerSession: 500,
      verificationStatus: 'approved',
      status: 'approved',
      isVerified: true,
      verification: { status: 'verified', level: 'verified', rejectionReason: '' },
      documents: [],
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw new CreateClinicPhysioError(409, 'Phone already registered');
    }
    throw err;
  }

  let user;
  try {
    user = await User.create({
      phone: pv.normalized,
      name: nameStr,
      email: '',
      dob: null,
      gender: 'prefer_not_to_say',
      address: { text: '', lat: null, lng: null },
      location,
      coordinates,
      passwordHash,
      hasPasswordLogin: true,
      isVerified: true,
      isProfileComplete: true,
      role: 'physio',
      physioId: physio._id,
    });
  } catch (err) {
    await Physiotherapist.findByIdAndDelete(physio._id).catch(() => {});
    if (err?.code === 11000) {
      throw new CreateClinicPhysioError(409, 'This phone number is already registered');
    }
    throw err;
  }

  try {
    await Clinic.findByIdAndUpdate(clinic._id, { $addToSet: { physioIds: physio._id } });
  } catch (err) {
    await User.findByIdAndDelete(user._id).catch(() => {});
    await Physiotherapist.findByIdAndDelete(physio._id).catch(() => {});
    throw err;
  }

  return {
    physio: physio.toObject(),
    user: {
      _id: user._id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      physioId: user.physioId,
    },
  };
}
