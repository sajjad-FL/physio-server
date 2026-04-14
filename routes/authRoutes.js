import { Router } from 'express';
import {
  registerPatient,
  sendSignupOtp,
  loginWithPassword,
  debugSendLoginOtp,
  forgotPassword,
  verifyPasswordResetOtp,
  resetPassword,
} from '../controllers/authController.js';
import { registerPhysio } from '../controllers/physioRegistrationController.js';
import { uploadOnboardingFiles } from '../config/upload.js';

const router = Router();

router.post('/register', registerPatient);
router.post('/signup-otp', sendSignupOtp);
router.post('/login', loginWithPassword);
router.post('/debug-login-otp', debugSendLoginOtp);
router.post('/forgot-password', forgotPassword);
router.post('/verify-otp', verifyPasswordResetOtp);
router.post('/reset-password', resetPassword);

router.post(
  '/register-physio',
  uploadOnboardingFiles.fields([
    { name: 'avatar', maxCount: 1 },
    { name: 'certificate', maxCount: 1 },
    { name: 'idProof', maxCount: 1 },
    { name: 'id_proof', maxCount: 1 },
    { name: 'registrationCertificate', maxCount: 1 },
    { name: 'selfieWithId', maxCount: 1 },
    { name: 'internshipCertificate', maxCount: 1 },
    { name: 'councilRegistrationCertificate', maxCount: 1 },
  ]),
  registerPhysio
);

export default router;
