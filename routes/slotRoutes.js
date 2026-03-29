import { Router } from 'express';
import { getSlots } from '../controllers/slotController.js';

const router = Router();

router.get('/', getSlots);

export default router;
