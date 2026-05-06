import { Router } from 'express';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { uploadAvatar } from '../config/upload.js';
import {
  getProfile,
  patchProfile,
  patchAvatar,
  registerExpoPushToken,
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
router.post('/expo-push-token', authenticateJwt, registerExpoPushToken);
router.patch('/avatar', authenticateJwt, avatarUploadMiddleware, patchAvatar);
router.patch('/', authenticateJwt, patchProfile);

export default router;
