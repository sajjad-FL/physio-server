import { Router } from 'express';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';
import { attachPhysio } from '../middleware/physioMiddleware.js';
import { requireNotesAccess } from '../middleware/notesAccessMiddleware.js';
import { createNotes, getNotesByBooking } from '../controllers/notesController.js';

const router = Router();

router.post('/', authenticateJwt, requireCompleteProfile, requireRoles('physio'), attachPhysio, createNotes);
router.get('/:bookingId', requireNotesAccess, getNotesByBooking);

export default router;
