import { Router } from 'express';
import {
  createOrder,
  verifyPayment,
  holdPayment,
  releasePayment,
} from '../controllers/paymentController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireAdmin } from '../middleware/adminMiddleware.js';

const router = Router();

router.post('/create-order', requireAuth, createOrder);
router.post('/verify', requireAuth, verifyPayment);
router.post('/hold', requireAuth, holdPayment);
router.post('/release', requireAdmin, releasePayment);

export default router;
