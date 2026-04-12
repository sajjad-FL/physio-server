import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import PlatformSettings from '../models/PlatformSettings.js';
import { persistPhysioUploadFile } from '../utils/physioFilePersist.js';
import {
  validateBasicSection,
  validateQualificationSection,
  validatePracticeSection,
} from '../utils/onboardingValidation.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';

function normalizeEmail(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function toAreas(val) {
  if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
  if (typeof val === 'string') return val.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function parseDob(input) {
  if (input == null || input === '') return null;
  const d = new Date(String(input).trim());
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function collectValidationErrors(body, files, opts = {}) {
  const errors = {};
  const requireSignedNda = Boolean(opts.requireSignedNda);

  const name = String(body.name || '').trim();
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const phoneCheck = validateIndianMobile(body.phone);
  const phone = phoneCheck.valid ? phoneCheck.normalized : '';
  const location = String(body.location || '').trim();

  if (!phoneCheck.valid) {
    errors.phone = phoneCheck.message;
  }
  if (password.length < 8) {
    errors.password = 'Password must be at least 8 characters';
  }

  Object.assign(
    errors,
    validateBasicSection({
      name,
      email,
      location,
      dob: body.dob,
      gender: body.gender,
      address: body.address,
    }).errors
  );

  const covLat =
    body.lat != null && String(body.lat).trim() !== '' ? Number(body.lat) : NaN;
  const covLng =
    body.lng != null && String(body.lng).trim() !== '' ? Number(body.lng) : NaN;
  if (!Number.isFinite(covLat) || !Number.isFinite(covLng)) {
    errors.location =
      errors.location ||
      'Use map search or “Pick on map” to set your coverage point (needed for patient booking).';
  } else if (covLat < -90 || covLat > 90 || covLng < -180 || covLng > 180) {
    errors.location = 'Invalid map coordinates';
  }

  Object.assign(
    errors,
    validateQualificationSection({
      degree: body.degree,
      university: body.university,
      year: body.year,
      registrationNumber: body.registrationNumber,
    }).errors
  );

  Object.assign(
    errors,
    validatePracticeSection({
      experience: body.experience,
      specialization: body.specialization,
      serviceType: body.serviceType,
      areas: body.areas,
      fees: body.fees,
    }).errors
  );

  const certificate = files?.certificate?.[0];
  const idProof = files?.idProof?.[0] || files?.id_proof?.[0];
  const registrationCertificate = files?.registrationCertificate?.[0];
  const selfieWithId = files?.selfieWithId?.[0];
  const signedNda = files?.signedNda?.[0];

  if (!certificate) errors.certificate = 'Qualification certificate is required';
  if (!idProof) errors.idProof = 'ID proof is required';
  if (!registrationCertificate) errors.registrationCertificate = 'Registration certificate is required';
  if (!selfieWithId) errors.selfieWithId = 'Selfie with ID is required';
  if (requireSignedNda && !signedNda) {
    errors.signedNda = 'Download the NDA, sign it, and upload the signed copy';
  }

  return {
    errors,
    name,
    email,
    password,
    phone,
    location,
    certificate,
    idProof,
    registrationCertificate,
    selfieWithId,
    signedNda,
    avatar: files?.avatar?.[0],
  };
}

export async function registerPhysio(req, res, next) {
  try {
    const body = req.body || {};
    const parsed = collectValidationErrors(body, req.files);

    if (Object.keys(parsed.errors).length > 0) {
      return res.status(400).json({
        message: 'Please fix the errors below',
        errors: parsed.errors,
      });
    }

    const {
      name,
      email,
      password,
      phone,
      location,
      certificate,
      idProof,
      registrationCertificate,
      selfieWithId,
      signedNda,
      avatar,
    } = parsed;

    if (!validateEmail(email)) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    const emailTaken = await User.findOne({ email }).lean();
    if (emailTaken) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    const phoneTaken = await User.findOne({ phone }).lean();
    if (phoneTaken) {
      return res.status(409).json({ message: 'An account with this phone already exists' });
    }

    const phoneTakenPhysio = await Physiotherapist.findOne({ phone }).lean();
    if (phoneTakenPhysio) {
      return res.status(409).json({ message: 'This phone is already registered as a physiotherapist' });
    }

    const dob = parseDob(body.dob);
    const gender = String(body.gender || '').trim();
    const address = String(body.address || '').trim();
    const degree = String(body.degree || '').trim();
    const university = String(body.university || '').trim();
    const year = Number(body.year);
    const registrationNumber = String(body.registrationNumber || '').trim();
    const experience = Number(body.experience);
    const specialization = String(body.specialization || '').trim();
    const serviceType = ['online', 'home', 'both'].includes(String(body.serviceType || '').trim())
      ? String(body.serviceType).trim()
      : 'both';
    const serviceAreas = toAreas(body.areas);
    const pricePerSession = Number(body.fees);

    const covLat = Number(body.lat);
    const covLng = Number(body.lng);
    const coordinates =
      Number.isFinite(covLat) &&
      Number.isFinite(covLng) &&
      covLat >= -90 &&
      covLat <= 90 &&
      covLng >= -180 &&
      covLng <= 180
        ? { lat: covLat, lng: covLng }
        : null;

    const passwordHash = await bcrypt.hash(password, 10);

    let physio = await Physiotherapist.create({
      name,
      email,
      phone,
      dob,
      gender: gender || '',
      address,
      location,
      coordinates,
      specialization,
      experience,
      serviceType,
      serviceAreas,
      pricePerSession,
      qualification: {
        degree,
        university,
        year: Number.isFinite(year) ? year : null,
        registrationNumber,
        certificateUrl: '',
      },
      documentUrls: {
        idProof: '',
        registrationCertificate: '',
        selfieWithId: '',
        signedNda: '',
      },
      avatar: '',
      verificationStatus: 'pending',
      status: 'pending',
      isVerified: false,
      verification: { status: 'pending', level: 'not_verified', rejectionReason: '' },
      documents: [],
      onboarding: { currentStep: 5, submittedAt: null },
    });

    const docs = [];
    const $set = {};

    try {
      const pid = physio._id.toString();

      if (avatar) {
        const url = await persistPhysioUploadFile(avatar, pid, 'avatar');
        $set.avatar = url;
        docs.push({ type: 'avatar', url, uploadedAt: new Date() });
      }

      const certUrl = await persistPhysioUploadFile(certificate, pid, 'certificate');
      $set['qualification.certificateUrl'] = certUrl;
      docs.push({ type: 'certificate', url: certUrl, uploadedAt: new Date() });

      const idUrl = await persistPhysioUploadFile(idProof, pid, 'id_proof');
      $set['documentUrls.idProof'] = idUrl;
      docs.push({ type: 'id_proof', url: idUrl, uploadedAt: new Date() });

      const regUrl = await persistPhysioUploadFile(registrationCertificate, pid, 'registration');
      $set['documentUrls.registrationCertificate'] = regUrl;
      docs.push({ type: 'registration_certificate', url: regUrl, uploadedAt: new Date() });

      const selfieUrl = await persistPhysioUploadFile(selfieWithId, pid, 'selfie_id');
      $set['documentUrls.selfieWithId'] = selfieUrl;
      docs.push({ type: 'selfie_with_id', url: selfieUrl, uploadedAt: new Date() });

      if (requireSignedNda && signedNda) {
        const ndaSignedUrl = await persistPhysioUploadFile(signedNda, pid, 'signed_nda');
        $set['documentUrls.signedNda'] = ndaSignedUrl;
        docs.push({ type: 'signed_nda', url: ndaSignedUrl, uploadedAt: new Date() });
      }

      physio = await Physiotherapist.findByIdAndUpdate(
        physio._id,
        { $set, $push: { documents: { $each: docs } } },
        { new: true }
      );
    } catch (fileErr) {
      await Physiotherapist.findByIdAndDelete(physio._id);
      throw fileErr;
    }

    try {
      const userPayload = {
        name,
        email,
        phone,
        passwordHash,
        hasPasswordLogin: true,
        role: 'physio',
        physioId: physio._id,
        isVerified: false,
        isProfileComplete: false,
        location,
      };
      if (dob) userPayload.dob = dob;
      if (gender && ['female', 'male', 'other', 'prefer_not_to_say'].includes(gender)) {
        userPayload.gender = gender;
      }
      if (address) {
        userPayload.address = { text: address, lat: null, lng: null };
      }
      if (coordinates) {
        userPayload.coordinates = coordinates;
      }
      const user = await User.create(userPayload);

      return res.status(201).json({
        message: 'Registration submitted. An administrator will review your application.',
        userId: user._id.toString(),
        physioId: physio._id.toString(),
        verificationStatus: 'pending',
      });
    } catch (err) {
      await Physiotherapist.findByIdAndDelete(physio._id);
      if (err?.code === 11000) {
        return res.status(409).json({ message: 'Email or phone already registered' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}
