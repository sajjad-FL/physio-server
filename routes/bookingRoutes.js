import { Router } from 'express';
import {
  createBooking,
  requestHomeBooking,
  createHomePlan,
  approveHomePlan,
  collectOfflinePayment,
  verifyOfflinePayment,
  rejectOfflinePayment,
  rescheduleBooking,
  listBookings,
  listMyBookings,
  updateBooking,
  getBookingById,
} from '../controllers/bookingController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireAdmin } from '../middleware/adminMiddleware.js';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';
import { attachPhysio } from '../middleware/physioMiddleware.js';

const router = Router();

router.post('/', requireAuth, createBooking);
router.post('/request-home', requireAuth, requestHomeBooking);
router.get('/mine', requireAuth, listMyBookings);
router.get('/my', requireAuth, listMyBookings);
router.get('/', requireAdmin, listBookings);
router.get('/:id', requireAuth, getBookingById);
router.patch(
  '/:id/reschedule',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  rescheduleBooking
);
router.patch('/:id', requireAdmin, updateBooking);
router.patch(
  '/:id/create-plan',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  createHomePlan
);
router.patch(
  '/:id/collect-payment',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('physio'),
  attachPhysio,
  collectOfflinePayment
);
router.patch('/:id/verify-payment', requireAdmin, verifyOfflinePayment);
router.patch('/:id/reject-payment', requireAdmin, rejectOfflinePayment);
router.patch('/:id/approve', requireAuth, approveHomePlan);

export default router;
