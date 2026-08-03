import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { persistPhysioUploadFile } from '../utils/physioFilePersist.js';
import {
  validateBasicSection,
  validateQualificationSection,
  validatePracticeSection,
} from '../utils/onboardingValidation.js';
import { validateIndianMobile } from '../utils/phoneIndia.js';
import { isValidIdProofType } from '../constants/idProofTypes.js';
import {
  isValidPhysioLanguage,
  parsePhysioLanguages,
} from '../constants/physioLanguages.js';

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

function truthyQualificationDeclaration(v) {
  return v === true || v === 'true' || v === 'on' || v === '1';
}

function looksLikeBrokenMultipartField(value) {
  const s = String(value ?? '').trim();
  return s === '[object Object]' || s === '[object File]';
}

function collectValidationErrors(body, files) {
  const errors = {};

  const name = String(body.name || '').trim();
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const phoneCheck = validateIndianMobile(body.phone);
  const phone = phoneCheck.valid ? phoneCheck.normalized : '';
  const location = String(body.location || '').trim();

  if (!phoneCheck.valid) {
    errors.phone = phoneCheck.message;
  }
  if (password.length < 6) {
    errors.password = 'Password must be at least 6 characters';
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
      'Pick your coverage area on the map (needed for patient booking).';
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
    validatePracticeSection(
      {
        experience: body.experience,
        specialization: body.specialization,
        serviceType: body.serviceType,
        areas: body.areas,
      },
      { specializationOptional: true },
    ).errors
  );

  const languages = parsePhysioLanguages(body.languages);
  if (languages.length === 0) {
    errors.languages = 'Select at least one language';
  } else if (languages.some((l) => !isValidPhysioLanguage(l))) {
    errors.languages = 'One or more selected languages are not allowed';
  }

  const certificate = files?.certificate?.[0];
  const idProof = files?.idProof?.[0] || files?.id_proof?.[0];
  const registrationCertificate = files?.registrationCertificate?.[0];
  const selfieWithId = files?.selfieWithId?.[0];
  const internshipCertificates = Array.isArray(files?.internshipCertificate)
    ? files.internshipCertificate
    : files?.internshipCertificate
      ? [files.internshipCertificate]
      : [];
  const idProofType = String(body.idProofType || '').trim().toLowerCase();

  const avatar = files?.avatar?.[0];
  if (!avatar) {
    if (looksLikeBrokenMultipartField(body.avatar)) {
      errors.avatar = 'Photo upload failed — re-select the file and submit again';
    } else {
      errors.avatar = 'Passport size photo is required';
    }
  }

  if (!certificate) {
    if (looksLikeBrokenMultipartField(body.certificate)) {
      errors.certificate = 'Certificate upload failed — re-select the file and submit again';
    } else {
      errors.certificate = 'BPT/MPT pass certificate is required';
    }
  }
  if (!idProof) {
    if (looksLikeBrokenMultipartField(body.idProof)) {
      errors.idProof = 'ID upload failed — re-select the file and submit again';
    } else {
      errors.idProof = 'GOVERNMENT ID is required';
    }
  }
  if (!selfieWithId) {
    if (looksLikeBrokenMultipartField(body.selfieWithId)) {
      errors.selfieWithId = 'Selfie upload failed — re-select the file and submit again';
    } else {
      errors.selfieWithId = 'Selfie with ID is required';
    }
  }
  if (internshipCertificates.length === 0) {
    if (looksLikeBrokenMultipartField(body.internshipCertificate)) {
      errors.internshipCertificate = 'Internship upload failed — re-select the file and submit again';
    } else {
      errors.internshipCertificate = 'Upload at least one internship certificate';
    }
  } else if (internshipCertificates.length > 10) {
    errors.internshipCertificate = 'You can upload up to 10 internship certificates at once';
  }
  if (!isValidIdProofType(idProofType)) {
    errors.idProofType = 'Select GOVT ID type (Aadhaar, PAN, Passport, or Voter ID)';
  }
  if (!truthyQualificationDeclaration(body.qualificationDeclaration)) {
    errors.qualificationDeclaration = 'You must agree to the qualification declaration';
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
    internshipCertificates,
    idProofType,
    avatar,
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
      internshipCertificates,
      idProofType,
      avatar,
    } = parsed;

    if (!validateEmail(email)) {
      return res.status(400).json({ message: 'Valid email is required' });
    }

    const [emailTakenUser, emailTakenPhysio] = await Promise.all([
      User.findOne({ email }).lean(),
      Physiotherapist.findOne({ email }).lean(),
    ]);
    if (emailTakenUser || emailTakenPhysio) {
      return res.status(409).json({
        message: 'This email is already registered',
        errors: { email: 'This email is already in use. Choose another or sign in.' },
      });
    }

    const phoneTaken = await User.findOne({ phone }).lean();
    if (phoneTaken) {
      return res.status(409).json({
        message: 'This phone is already registered',
        errors: { phone: 'This phone is already in use. Choose another or sign in.' },
      });
    }

    const phoneTakenPhysio = await Physiotherapist.findOne({ phone }).lean();
    if (phoneTakenPhysio) {
      return res.status(409).json({
        message: 'This phone is already registered as a physiotherapist',
        errors: { phone: 'This phone is already in use. Choose another or sign in.' },
      });
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
    const languages = parsePhysioLanguages(body.languages);

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

    let physio;
    try {
      physio = await Physiotherapist.create({
        name,
        email,
        phone,
        dob,
        gender: gender || '',
        address,
        location,
        coordinates,
        languages,
        specialization,
        experience,
        serviceType,
        serviceAreas,
        qualification: {
          degree,
          university,
          year: Number.isFinite(year) ? year : null,
          registrationNumber,
          certificateUrl: '',
        },
        documentUrls: {
          idProof: '',
          idProofType: '',
          registrationCertificate: '',
          selfieWithId: '',
          internshipCertificate: '',
          internshipCertificates: [],
          signedNda: '',
        },
        avatar: '',
        qualificationDeclarationAcceptedAt: new Date(),
        verificationStatus: 'pending',
        status: 'pending',
        isVerified: false,
        verification: { status: 'pending', level: 'not_verified', rejectionReason: '' },
        documents: [],
        onboarding: { currentStep: 5, submittedAt: null },
      });
    } catch (createErr) {
      if (createErr?.code === 11000) {
        const key = Object.keys(createErr.keyPattern || createErr.keyValue || {})[0];
        if (key === 'email') {
          return res.status(409).json({
            message: 'This email is already registered',
            errors: { email: 'This email is already in use. Choose another or sign in.' },
          });
        }
        return res.status(409).json({
          message: 'Duplicate registration',
          errors: { phone: 'This phone may already be registered.' },
        });
      }
      throw createErr;
    }

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
      $set['documentUrls.idProofType'] = idProofType;
      docs.push({ type: 'id_proof', url: idUrl, uploadedAt: new Date() });

      const regUrl = registrationCertificate
        ? await persistPhysioUploadFile(registrationCertificate, pid, 'registration')
        : null;
      if (regUrl) {
        $set['documentUrls.registrationCertificate'] = regUrl;
        docs.push({ type: 'registration_certificate', url: regUrl, uploadedAt: new Date() });
      }

      const selfieUrl = await persistPhysioUploadFile(selfieWithId, pid, 'selfie_id');
      $set['documentUrls.selfieWithId'] = selfieUrl;
      docs.push({ type: 'selfie_with_id', url: selfieUrl, uploadedAt: new Date() });

      const internshipUrls = [];
      for (let i = 0; i < internshipCertificates.length; i += 1) {
        const file = internshipCertificates[i];
        const u = await persistPhysioUploadFile(file, pid, `internship_${i + 1}`);
        internshipUrls.push(u);
        docs.push({ type: 'internship_certificate', url: u, uploadedAt: new Date() });
      }
      if (internshipUrls.length) {
        $set['documentUrls.internshipCertificates'] = internshipUrls;
        $set['documentUrls.internshipCertificate'] = internshipUrls[0];
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
        const dupKey = Object.keys(err.keyPattern || err.keyValue || {})[0];
        if (dupKey === 'email') {
          return res.status(409).json({
            message: 'This email is already registered',
            errors: { email: 'This email is already in use. Choose another or sign in.' },
          });
        }
        return res.status(409).json({
          message: 'This phone is already registered',
          errors: { phone: 'This phone is already in use. Choose another or sign in.' },
        });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}
