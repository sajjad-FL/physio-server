import { Router } from 'express';
import { requirePatientOrPhysio } from '../middleware/patientOrPhysioMiddleware.js';
import { raiseDispute, listMyDisputes } from '../controllers/disputeController.js';

const router = Router();

router.post('/', requirePatientOrPhysio, raiseDispute);
router.get('/my', requirePatientOrPhysio, listMyDisputes);

export default router;
