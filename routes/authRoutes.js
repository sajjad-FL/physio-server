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
import { authLimiter, forgotPasswordLimiter } from '../middleware/rateLimiter.js';

const router = Router();

router.post('/register', authLimiter, registerPatient);
// Backward compatibility for older/mobile clients expecting /auth/send-otp
router.post('/send-otp', authLimiter, sendSignupOtp);
router.post('/signup-otp', authLimiter, sendSignupOtp);
router.post('/login', authLimiter, loginWithPassword);
router.post('/debug-login-otp', authLimiter, debugSendLoginOtp);
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/verify-otp', authLimiter, verifyPasswordResetOtp);
router.post('/reset-password', authLimiter, resetPassword);

router.post(
  '/register-physio',
  authLimiter,
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
