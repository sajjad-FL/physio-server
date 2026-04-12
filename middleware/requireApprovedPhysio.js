import { isPhysioPlatformApproved } from '../utils/physioVerification.js';

/**
 * After `attachPhysio`. Blocks physio portal until admin approves the Physiotherapist profile.
 */
export function requireApprovedPhysio(req, res, next) {
  const doc = req.physio?.doc;
  if (!doc) {
    return res.status(403).json({ message: 'Physiotherapist session required' });
  }

  const rejected =
    doc.verificationStatus === 'rejected' || doc.verification?.status === 'rejected';
  if (rejected) {
    return res.status(403).json({
      message: 'Your profile was rejected. Please contact support or reapply.',
      code: 'PHYSIO_REJECTED',
    });
  }

  if (!isPhysioPlatformApproved(doc)) {
    return res.status(403).json({
      message: 'Your profile is under approval',
      code: 'PHYSIO_PENDING',
    });
  }

  next();
}
