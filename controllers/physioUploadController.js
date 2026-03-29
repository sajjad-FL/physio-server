import Physiotherapist from '../models/Physiotherapist.js';
import { isS3Configured, uploadPhysioAsset } from '../utils/s3Upload.js';

async function persistFile(file, physioId, subpath) {
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
    'verification.rejectionReason': '',
    verificationStatus: 'pending',
    status: 'pending',
    isVerified: false,
  };
}

export async function uploadDocuments(req, res, next) {
  try {
    const physioId = req.physio?.id;
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
    const f = req.files || {};

    const avatar = f.avatar?.[0];
    const certificate = f.certificate?.[0] || f.degree?.[0];
    const idProof = f.idProof?.[0] || f.id_proof?.[0];
    const registrationCertificate = f.registrationCertificate?.[0];
    const selfieWithId = f.selfieWithId?.[0];

    if (!avatar && !certificate && !idProof && !registrationCertificate && !selfieWithId) {
      return res.status(400).json({ message: 'Provide at least one file' });
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
