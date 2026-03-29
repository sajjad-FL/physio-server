import { Router } from 'express';
import {
  createWithdrawRequest,
  getPendingWithdraw,
  listWithdrawRequests,
  updateWithdrawStatus,
} from '../controllers/withdrawController.js';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';
import { attachPhysio } from '../middleware/physioMiddleware.js';
import { requireAdmin } from '../middleware/adminMiddleware.js';

const router = Router();

router.get(
  '/pending',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  getPendingWithdraw
);
router.post(
  '/',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  createWithdrawRequest
);

router.get('/', requireAdmin, listWithdrawRequests);
router.patch('/:id', requireAdmin, updateWithdrawStatus);

export default router;
