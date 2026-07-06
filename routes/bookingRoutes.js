import { Router } from 'express';
import {
  createBooking,
  requestHomeBooking,
  createHomePlan,
  approveHomePlan,
  consentToPlan,
  collectOfflinePayment,
  verifyOfflinePayment,
  rejectOfflinePayment,
  rescheduleBooking,
  listBookings,
  listMyBookings,
  updateBooking,
  getBookingById,
  confirmSession,
} from '../controllers/bookingController.js';
import {
  startOnlineCheckout,
  completeOnlineCheckout,
  renderHostedOnlineCheckoutPage,
  completeHostedOnlineCheckout,
} from '../controllers/onlineCheckoutController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireAdmin } from '../middleware/adminMiddleware.js';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';
import { attachPhysio } from '../middleware/physioMiddleware.js';
import { requireApprovedPhysio } from '../middleware/requireApprovedPhysio.js';

const router = Router();

router.post('/', requireAuth, createBooking);
router.post('/online-checkout/start', requireAuth, startOnlineCheckout);
router.post('/online-checkout/complete', requireAuth, completeOnlineCheckout);
router.get('/online-checkout/hosted/:sessionId', renderHostedOnlineCheckoutPage);
router.post('/online-checkout/complete-hosted', completeHostedOnlineCheckout);
router.post('/request-home', requireAuth, requestHomeBooking);
router.get('/mine', requireAuth, listMyBookings);
router.get('/my', requireAuth, listMyBookings);
router.get('/', requireAdmin, listBookings);
router.post('/:bookingId/sessions/:sessionId/confirm', requireAuth, confirmSession);
router.get(
  '/:id',
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('user', 'care_manager'),
  getBookingById
);
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
  requireRoles('physio'),
  attachPhysio,
  requireApprovedPhysio,
  requireCompleteProfile,
  createHomePlan
);
router.patch(
  '/:id/collect-payment',
  authenticateJwt,
  requireRoles('physio'),
  attachPhysio,
  requireApprovedPhysio,
  requireCompleteProfile,
  collectOfflinePayment
);
router.patch('/:id/verify-payment', requireAdmin, verifyOfflinePayment);
router.patch('/:id/reject-payment', requireAdmin, rejectOfflinePayment);
router.post('/:id/consent-plan', requireAuth, consentToPlan);
router.patch('/:id/approve', requireAuth, approveHomePlan);

export default router;
