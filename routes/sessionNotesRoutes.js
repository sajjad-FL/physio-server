import { Router } from 'express';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';
import { attachPhysio } from '../middleware/physioMiddleware.js';
import { patchSessionNotes } from '../controllers/sessionNotesController.js';

const router = Router();

router.patch(
  '/:sessionId/notes',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  patchSessionNotes
);

export default router;
