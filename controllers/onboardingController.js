import Physiotherapist from '../models/Physiotherapist.js';
import PlatformSettings from '../models/PlatformSettings.js';
import { isPhysioOnboardingLocked, isPhysioPlatformApproved } from '../utils/physioVerification.js';
import {
  validateBasicSection,
  validateQualificationSection,
  validatePracticeSection,
  validateSubmitReady,
} from '../utils/onboardingValidation.js';

function toAreas(val) {
  if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
  if (typeof val === 'string') return val.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function sendValidationError(res, message, errors) {
  return res.status(400).json({ message, errors });
}

function mongooseErrorsToClient(err) {
  const errors = {};
  if (!err?.errors) return errors;
  for (const [path, detail] of Object.entries(err.errors)) {
    const key = path.includes('.') ? path.split('.').pop() : path;
    if (detail?.message) errors[key] = detail.message;
  }
  return errors;
}

function handleMongooseValidation(err, res) {
  if (err?.name === 'ValidationError' && err.errors) {
    const errors = mongooseErrorsToClient(err);
    return res.status(400).json({
      message: err.message || 'Validation failed',
      errors,
    });
  }
  return false;
}

export async function getOnboarding(req, res, next) {
  try {
    const physio = await Physiotherapist.findById(req.physio.id).lean();
    if (!physio) return res.status(404).json({ message: 'Not found' });
    const onboardingLocked = isPhysioOnboardingLocked(physio);
    return res.json({
      ...physio,
      onboardingLocked,
      platformApproved: isPhysioPlatformApproved(physio),
    });
  } catch (err) {
    next(err);
  }
}

export async function patchOnboarding(req, res, next) {
  try {
    const pid = req.physio.id;
    const existingPatch = await Physiotherapist.findById(pid).lean();
    if (!existingPatch) return res.status(404).json({ message: 'Not found' });
    if (isPhysioOnboardingLocked(existingPatch)) {
      return res.status(403).json({
        message: 'Onboarding cannot be edited after your profile is verified.',
      });
    }

    const { step, basic, qualification, practice } = req.body || {};

    if (basic !== undefined) {
      if (!basic || typeof basic !== 'object' || Array.isArray(basic)) {
        return sendValidationError(res, 'Invalid request', { basic: 'Basic must be an object' });
      }
      const { errors } = validateBasicSection(basic);
      if (Object.keys(errors).length) {
        return sendValidationError(res, 'Please fix the fields below', errors);
      }
    }

    if (qualification !== undefined) {
      if (!qualification || typeof qualification !== 'object' || Array.isArray(qualification)) {
        return sendValidationError(res, 'Invalid request', { qualification: 'Qualification must be an object' });
      }
      const { errors } = validateQualificationSection(qualification);
      if (Object.keys(errors).length) {
        return sendValidationError(res, 'Please fix the fields below', errors);
      }
    }

    if (practice !== undefined) {
      if (!practice || typeof practice !== 'object' || Array.isArray(practice)) {
        return sendValidationError(res, 'Invalid request', { practice: 'Practice must be an object' });
      }
      const { errors } = validatePracticeSection(practice);
      if (Object.keys(errors).length) {
        return sendValidationError(res, 'Please fix the fields below', errors);
      }
    }

    const $set = {};

    if (step !== undefined) {
      const s = Number(step);
      if (Number.isFinite(s)) {
        $set['onboarding.currentStep'] = Math.min(5, Math.max(1, Math.round(s)));
      }
    }

    if (basic && typeof basic === 'object') {
      if (String(basic.name ?? '').trim()) $set.name = String(basic.name).trim();
      if (basic.email != null) $set.email = String(basic.email).trim();
      if (basic.dob != null && String(basic.dob).trim()) {
        const d = new Date(basic.dob);
        if (!Number.isNaN(d.getTime())) $set.dob = d;
      }
      if (basic.gender != null) $set.gender = String(basic.gender).trim();
      if (basic.address != null) $set.address = String(basic.address).trim();
      if (String(basic.location ?? '').trim()) $set.location = String(basic.location).trim();
    }

    if (qualification && typeof qualification === 'object') {
      if (qualification.degree != null) $set['qualification.degree'] = String(qualification.degree).trim();
      if (qualification.university != null) {
        $set['qualification.university'] = String(qualification.university).trim();
      }
      if (qualification.year != null && qualification.year !== '') {
        const y = Number(qualification.year);
        if (Number.isFinite(y)) $set['qualification.year'] = y;
      }
      if (qualification.registrationNumber != null) {
        $set['qualification.registrationNumber'] = String(qualification.registrationNumber).trim();
      }
    }

    if (practice && typeof practice === 'object') {
      if (practice.experience != null && practice.experience !== '') {
        const e = Number(practice.experience);
        if (Number.isFinite(e) && e >= 0) $set.experience = e;
      }
      if (practice.specialization != null && String(practice.specialization).trim()) {
        $set.specialization = String(practice.specialization).trim();
      }
      if (practice.serviceType != null && ['online', 'home', 'both'].includes(practice.serviceType)) {
        $set.serviceType = practice.serviceType;
      }
      const areas = toAreas(practice.areas);
      if (areas.length) $set.serviceAreas = areas;
      if (practice.fees != null && practice.fees !== '') {
        const fee = Number(practice.fees);
        if (Number.isFinite(fee) && fee > 0) $set.pricePerSession = fee;
      }
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    let physio;
    try {
      physio = await Physiotherapist.findByIdAndUpdate(pid, { $set }, { new: true, runValidators: true }).lean();
    } catch (err) {
      if (handleMongooseValidation(err, res)) return;
      throw err;
    }

    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json(physio);
  } catch (err) {
    next(err);
  }
}

export async function submitOnboarding(req, res, next) {
  try {
    const pid = req.physio.id;
    const existing = await Physiotherapist.findById(pid).lean();
    if (!existing) return res.status(404).json({ message: 'Not found' });

    if (isPhysioOnboardingLocked(existing)) {
      return res.status(403).json({
        message: 'Your profile is already verified. You do not need to submit again.',
      });
    }

    const ndaDoc = await PlatformSettings.findById('singleton').lean();
    const requireSignedNda = Boolean(String(ndaDoc?.physioNdaTemplateUrl || '').trim());
    const { ok, errors } = validateSubmitReady(existing, { requireSignedNda });
    if (!ok) {
      return sendValidationError(
        res,
        'Complete all required information and document uploads before submitting',
        errors
      );
    }

    let physio;
    try {
      physio = await Physiotherapist.findByIdAndUpdate(
        pid,
        {
          $set: {
            'onboarding.submittedAt': new Date(),
            'onboarding.currentStep': 5,
            'verification.status': 'pending',
            'verification.level': 'not_verified',
            'verification.rejectionReason': '',
            verificationStatus: 'pending',
            status: 'pending',
            isVerified: false,
          },
        },
        { new: true, runValidators: true }
      ).lean();
    } catch (err) {
      if (handleMongooseValidation(err, res)) return;
      throw err;
    }

    if (!physio) return res.status(404).json({ message: 'Not found' });
    return res.json({ message: 'Application submitted for review', physio });
  } catch (err) {
    next(err);
  }
}
