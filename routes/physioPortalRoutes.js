import { Router } from 'express';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';
import { attachPhysio } from '../middleware/physioMiddleware.js';
import { uploadPhysioDocs, uploadOnboardingFiles } from '../config/upload.js';
import {
  listMyBookings,
  getPhysioBookingById,
  patchAvailability,
  patchLocation,
  completeSession,
  getMe,
} from '../controllers/physioPortalController.js';
import { getWalletDashboard, listWalletTransactions } from '../controllers/walletController.js';
import { uploadDocuments, uploadOnboardingFiles as saveOnboardingFiles } from '../controllers/physioUploadController.js';
import { getOnboarding, patchOnboarding, submitOnboarding } from '../controllers/onboardingController.js';

const router = Router();

router.get('/me', authenticateJwt, requireCompleteProfile, requireRoles('physio'), attachPhysio, getMe);
router.get(
  '/wallet',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  getWalletDashboard
);
router.get(
  '/wallet/transactions',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  listWalletTransactions
);
router.get('/bookings', authenticateJwt, requireCompleteProfile, requireRoles('physio'), attachPhysio, listMyBookings);
router.get('/bookings/:id', authenticateJwt, requireCompleteProfile, requireRoles('physio'), attachPhysio, getPhysioBookingById);
router.patch(
  '/availability',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  patchAvailability
);
router.patch(
  '/location',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  patchLocation
);
router.post(
  '/sessions/:bookingId/complete',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  completeSession
);
router.post(
  '/upload-documents',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  uploadPhysioDocs.fields([
    { name: 'degree', maxCount: 1 },
    { name: 'id_proof', maxCount: 1 },
  ]),
  uploadDocuments
);

router.get(
  '/onboarding',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  getOnboarding
);
router.patch(
  '/onboarding',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  patchOnboarding
);
router.post(
  '/onboarding/submit',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  submitOnboarding
);
router.post(
  '/onboarding/upload',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  uploadOnboardingFiles.fields([
    { name: 'avatar', maxCount: 1 },
    { name: 'certificate', maxCount: 1 },
    { name: 'degree', maxCount: 1 },
    { name: 'idProof', maxCount: 1 },
    { name: 'id_proof', maxCount: 1 },
    { name: 'registrationCertificate', maxCount: 1 },
    { name: 'selfieWithId', maxCount: 1 },
  ]),
  saveOnboardingFiles
);

export default router;
