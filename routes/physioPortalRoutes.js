import { Router } from 'express';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';
import { attachPhysio } from '../middleware/physioMiddleware.js';
import { requireApprovedPhysio } from '../middleware/requireApprovedPhysio.js';
import { uploadPhysioDocs, uploadOnboardingFiles } from '../config/upload.js';
import {
  listMyBookings,
  getPhysioBookingById,
  respondToAssignment,
  patchAvailability,
  patchLocation,
  completeSession,
  getMe,
} from '../controllers/physioPortalController.js';
import { getWalletDashboard, listWalletTransactions } from '../controllers/walletController.js';
import { uploadDocuments, uploadOnboardingFiles as saveOnboardingFiles } from '../controllers/physioUploadController.js';
import { getOnboarding, patchOnboarding, submitOnboarding } from '../controllers/onboardingController.js';

const router = Router();

/** Logged-in physio; onboarding may run before admin approval. */
const physioOnboardingChain = [authenticateJwt, requireRoles('physio'), attachPhysio];

/** Bookings, wallet, etc.: approved on platform + complete user profile. */
const physioOperationalChain = [
  authenticateJwt,
  requireRoles('physio'),
  attachPhysio,
  requireApprovedPhysio,
  requireCompleteProfile,
];

router.get('/me', ...physioOnboardingChain, getMe);
router.get('/wallet', ...physioOperationalChain, getWalletDashboard);
router.get('/wallet/transactions', ...physioOperationalChain, listWalletTransactions);
router.get('/bookings', ...physioOperationalChain, listMyBookings);
router.patch('/bookings/:id/assignment', ...physioOperationalChain, respondToAssignment);
router.get('/bookings/:id', ...physioOperationalChain, getPhysioBookingById);
router.patch('/availability', ...physioOperationalChain, patchAvailability);
router.patch('/location', ...physioOperationalChain, patchLocation);
router.post('/sessions/:bookingId/complete', ...physioOperationalChain, completeSession);
router.post(
  '/upload-documents',
  ...physioOnboardingChain,
  uploadPhysioDocs.fields([
    { name: 'degree', maxCount: 1 },
    { name: 'id_proof', maxCount: 1 },
  ]),
  uploadDocuments
);

router.get('/onboarding', ...physioOnboardingChain, getOnboarding);
router.patch('/onboarding', ...physioOnboardingChain, patchOnboarding);
router.post('/onboarding/submit', ...physioOnboardingChain, submitOnboarding);
router.post(
  '/onboarding/upload',
  ...physioOnboardingChain,
  uploadOnboardingFiles.fields([
    { name: 'avatar', maxCount: 1 },
    { name: 'certificate', maxCount: 1 },
    { name: 'degree', maxCount: 1 },
    { name: 'idProof', maxCount: 1 },
    { name: 'id_proof', maxCount: 1 },
    { name: 'registrationCertificate', maxCount: 1 },
    { name: 'selfieWithId', maxCount: 1 },
    { name: 'internshipCertificate', maxCount: 1 },
    { name: 'councilRegistrationCertificate', maxCount: 1 },
  ]),
  saveOnboardingFiles
);

export default router;
