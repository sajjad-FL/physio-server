import { Router } from 'express';
import {
  createPhysio,
  listPhysios,
  listNearbyPhysios,
  getPublicPhysioProfile,
} from '../controllers/physioController.js';
import { listPhysioReviews } from '../controllers/reviewController.js';
import { requireAdmin } from '../middleware/adminMiddleware.js';

const router = Router();

router.get('/nearby', listNearbyPhysios);
router.get('/:id/reviews', listPhysioReviews);
router.get('/:id', getPublicPhysioProfile);
router.post('/', requireAdmin, createPhysio);
router.get('/', requireAdmin, listPhysios);

export default router;
