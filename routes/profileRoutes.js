import { Router } from 'express';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { uploadAvatar } from '../config/upload.js';
import {
  getProfile,
  patchProfile,
  patchAvatar,
  patchPayoutDetails,
  registerExpoPushToken,
  getWalletSummary,
} from '../controllers/profileController.js';

const router = Router();

function avatarUploadMiddleware(req, res, next) {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || 'Upload failed' });
    }
    next();
  });
}

router.get('/', authenticateJwt, getProfile);
router.get('/wallet-summary', authenticateJwt, getWalletSummary);
router.post('/expo-push-token', authenticateJwt, registerExpoPushToken);
router.patch('/avatar', authenticateJwt, avatarUploadMiddleware, patchAvatar);
router.patch('/payout', authenticateJwt, patchPayoutDetails);
router.patch('/', authenticateJwt, patchProfile);

export default router;
