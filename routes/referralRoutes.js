import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import {
  getMyReferralCode,
  getPublicReferralSettings,
  getReferralStats,
} from '../controllers/referralController.js';

const router = Router();

router.get('/public-settings', getPublicReferralSettings);
router.use(requireAuth);
router.get('/my-code', getMyReferralCode);
router.get('/stats', getReferralStats);

export default router;
