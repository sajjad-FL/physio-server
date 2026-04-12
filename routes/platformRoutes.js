import { Router } from 'express';
import { getPublicPhysioNda } from '../controllers/platformSettingsController.js';

const router = Router();

router.get('/physio-nda', getPublicPhysioNda);

export default router;
