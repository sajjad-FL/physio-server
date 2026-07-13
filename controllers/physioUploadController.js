import Physiotherapist from '../models/Physiotherapist.js';
import { isS3Configured, uploadPhysioAsset } from '../utils/s3Upload.js';
import { isPhysioOnboardingLocked } from '../utils/physioVerification.js';
import { isValidIdProofType } from '../constants/idProofTypes.js';
import { ensureCompressedMulterImage } from '../utils/compressImageBuffer.js';

async function persistFile(file, physioId, subpath) {
  await ensureCompressedMulterImage(file, { maxEdge: 2048 });
  if (file.buffer) {
    if (!isS3Configured()) {
      throw new Error('S3 is not configured but upload used memory storage');
    }
    return uploadPhysioAsset(file.buffer, `physio/${physioId}/${subpath}`, file.originalname, file.mimetype);
  }
  return '/uploads/' + file.filename;
}

function pendingVerificationUpdate() {
  return {
    'verification.status': 'pending',
    'verification.level': 'not_verified',
    'verification.rejectionReason': '',
    verificationStatus: 'pending',
    status: 'pending',
    isVerified: false,
  };
}

export async function uploadDocuments(req, res, next) {
  try {
    const physioId = req.physio?.id;
    const existingDoc = await Physiotherapist.findById(physioId).lean();
    if (!existingDoc) return res.status(404).json({ message: 'Not found' });
    if (isPhysioOnboardingLocked(existingDoc)) {
      return res.status(403).json({
        message: 'Documents cannot be updated after your profile is verified.',
      });
    }

    const degree = req.files?.degree?.[0];
    const idProof = req.files?.id_proof?.[0];

    if (!degree && !idProof) {
      return res.status(400).json({ message: 'Upload degree and/or id_proof files' });
    }

    const docs = [];
    const $set = { ...pendingVerificationUpdate() };

    if (degree) {
      const url = await persistFile(degree, physioId, 'degree');
      docs.push({ type: 'degree', url, uploadedAt: new Date() });
      $set['qualification.certificateUrl'] = url;
    }
    if (idProof) {
      const url = await persistFile(idProof, physioId, 'id_proof');
      docs.push({ type: 'id_proof', url, uploadedAt: new Date() });
      $set['documentUrls.idProof'] = url;
    }

    const update = { $set, $push: { documents: { $each: docs } } };
    const physio = await Physiotherapist.findByIdAndUpdate(physioId, update, { new: true }).lean();
    if (!physio) return res.status(404).json({ message: 'Not found' });

    return res.json({ message: 'Uploaded', physio });
  } catch (err) {
    next(err);
  }
}

export async function uploadOnboardingFiles(req, res, next) {
  try {
    const physioId = req.physio?.id;
    const existingUp = await Physiotherapist.findById(physioId).lean();
    if (!existingUp) return res.status(404).json({ message: 'Not found' });
    if (isPhysioOnboardingLocked(existingUp)) {
      return res.status(403).json({
        message: 'Onboarding uploads are locked after your profile is verified.',
      });
    }

    const f = req.files || {};

    const avatar = f.avatar?.[0];
    const certificate = f.certificate?.[0] || f.degree?.[0];
    const idProof = f.idProof?.[0] || f.id_proof?.[0];
    const registrationCertificate = f.registrationCertificate?.[0];
    const selfieWithId = f.selfieWithId?.[0];
    const internshipCertificateFiles = Array.isArray(f.internshipCertificate)
      ? f.internshipCertificate
      : f.internshipCertificate
        ? [f.internshipCertificate]
        : [];

    const idProofTypeRaw = req.body?.idProofType;
    const idProofType =
      idProofTypeRaw !== undefined && idProofTypeRaw !== null && String(idProofTypeRaw).trim() !== ''
        ? String(idProofTypeRaw).trim().toLowerCase()
        : null;

    if (
      !avatar &&
      !certificate &&
      !idProof &&
      !registrationCertificate &&
      !selfieWithId &&
      internshipCertificateFiles.length === 0 &&
      idProofType === null
    ) {
      return res.status(400).json({ message: 'Provide at least one file or idProofType' });
    }

    if (idProofType !== null && !isValidIdProofType(idProofType)) {
      return res.status(400).json({
        message: 'Invalid idProofType',
        errors: { idProofType: 'Select Aadhaar, PAN, Passport, or Voter ID' },
      });
    }

    if (internshipCertificateFiles.length > 10) {
      return res.status(400).json({
        message: 'Too many internship files',
        errors: { internshipCertificate: 'You can upload up to 10 internship certificates at once' },
      });
    }

    const $set = { ...pendingVerificationUpdate() };
    const newDocs = [];

    if (avatar) {
      const url = await persistFile(avatar, physioId, 'avatar');
      $set.avatar = url;
      newDocs.push({ type: 'avatar', url, uploadedAt: new Date() });
    }
    if (certificate) {
      const url = await persistFile(certificate, physioId, 'certificate');
      $set['qualification.certificateUrl'] = url;
      newDocs.push({ type: 'certificate', url, uploadedAt: new Date() });
    }
    if (idProof) {
      const url = await persistFile(idProof, physioId, 'id_proof');
      $set['documentUrls.idProof'] = url;
      newDocs.push({ type: 'id_proof', url, uploadedAt: new Date() });
    }
    if (registrationCertificate) {
      const url = await persistFile(registrationCertificate, physioId, 'registration');
      $set['documentUrls.registrationCertificate'] = url;
      newDocs.push({ type: 'registration_certificate', url, uploadedAt: new Date() });
    }
    if (selfieWithId) {
      const url = await persistFile(selfieWithId, physioId, 'selfie_id');
      $set['documentUrls.selfieWithId'] = url;
      newDocs.push({ type: 'selfie_with_id', url, uploadedAt: new Date() });
    }
    if (internshipCertificateFiles.length) {
      const existing = Array.isArray(existingUp.documentUrls?.internshipCertificates)
        ? existingUp.documentUrls.internshipCertificates.filter(Boolean)
        : existingUp.documentUrls?.internshipCertificate
          ? [existingUp.documentUrls.internshipCertificate]
          : [];
      const uploadedUrls = [];
      for (let i = 0; i < internshipCertificateFiles.length; i += 1) {
        const file = internshipCertificateFiles[i];
        const url = await persistFile(file, physioId, `internship_${existing.length + i + 1}`);
        uploadedUrls.push(url);
        newDocs.push({ type: 'internship_certificate', url, uploadedAt: new Date() });
      }
      const merged = [...existing, ...uploadedUrls];
      $set['documentUrls.internshipCertificates'] = merged;
      $set['documentUrls.internshipCertificate'] = merged[0] || '';
    }
    if (idProofType !== null) {
      $set['documentUrls.idProofType'] = idProofType;
    }

    const update = { $set };
    if (newDocs.length) {
      update.$push = { documents: { $each: newDocs } };
    }

    const physio = await Physiotherapist.findByIdAndUpdate(physioId, update, { new: true }).lean();
    if (!physio) return res.status(404).json({ message: 'Not found' });

    return res.json({ message: 'Uploaded', physio });
  } catch (err) {
    next(err);
  }
}
