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
import { requireApprovedPhysio } from '../middleware/requireApprovedPhysio.js';
import { requireAdmin } from '../middleware/adminMiddleware.js';

const router = Router();

router.get(
  '/pending',
  authenticateJwt,
  requireRoles('physio'),
  attachPhysio,
  requireApprovedPhysio,
  requireCompleteProfile,
  getPendingWithdraw
);
router.post(
  '/',
  authenticateJwt,
  requireRoles('physio'),
  attachPhysio,
  requireApprovedPhysio,
  requireCompleteProfile,
  createWithdrawRequest
);

router.get('/', requireAdmin, listWithdrawRequests);
router.patch('/:id', requireAdmin, updateWithdrawStatus);

export default router;
