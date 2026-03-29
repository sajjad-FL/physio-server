import { Router } from 'express';
import { createReview } from '../controllers/reviewController.js';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';

const router = Router();

router.post(
  '/',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('user'),
  createReview
);

export default router;
