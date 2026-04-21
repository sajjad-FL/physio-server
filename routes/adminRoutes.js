import { Router } from 'express';
import { requireAdmin } from '../middleware/adminMiddleware.js';
import {
  listPhysioVerifications,
  patchPhysioVerification,
  listDisputes,
  resolveAdminDispute,
  listAdminUsers,
  createPhysioFromUser,
  listAdminPhysios,
  getAdminPhysioById,
  patchAdminPhysio,
  deleteAdminPhysio,
  verifyAdminPhysio,
  listPendingPhysios,
  approvePhysioAdmin,
  rejectPhysioAdmin,
  getAdminNavCounts,
} from '../controllers/adminController.js';
import {
  addAdminBookingSession,
  deleteAdminBookingSession,
  getAdminBookingById,
  rescheduleBooking,
} from '../controllers/bookingController.js';
import {
  getPaymentSummary,
  postSettleCommission,
  listPhysiosWalletTable,
  getPhysioFinanceDetail,
} from '../controllers/paymentAnalyticsController.js';
import { listPaymentsQueue } from '../controllers/adminPaymentsController.js';
import {
  adminVerifyPayment,
  adminRejectPayment,
} from '../controllers/installmentsController.js';
import { getAdminPlatformSettings, patchAdminPlatformSettings, uploadPhysioNdaTemplate } from '../controllers/platformSettingsController.js';

const router = Router();

router.get('/nav-counts', requireAdmin, getAdminNavCounts);
router.get('/users', requireAdmin, listAdminUsers);
router.post('/physios/from-user', requireAdmin, createPhysioFromUser);
router.get('/physios', requireAdmin, listAdminPhysios);
router.get('/physio/pending', requireAdmin, listPendingPhysios);
router.put('/physio/:id/approve', requireAdmin, approvePhysioAdmin);
router.put('/physio/:id/reject', requireAdmin, rejectPhysioAdmin);
router.get('/physios/:id', requireAdmin, getAdminPhysioById);
router.patch('/physios/:id', requireAdmin, patchAdminPhysio);
router.delete('/physios/:id', requireAdmin, deleteAdminPhysio);
router.patch('/physios/:id/verify', requireAdmin, verifyAdminPhysio);
router.get('/physio-verifications', requireAdmin, listPhysioVerifications);
router.patch('/physio-verifications/:id', requireAdmin, patchPhysioVerification);
router.get('/disputes', requireAdmin, listDisputes);
router.patch('/disputes/:id', requireAdmin, resolveAdminDispute);
router.get('/bookings/:id', requireAdmin, getAdminBookingById);
router.patch('/bookings/:id/reschedule', requireAdmin, rescheduleBooking);
router.post('/bookings/:id/sessions', requireAdmin, addAdminBookingSession);
router.delete('/bookings/:id/sessions/:sessionId', requireAdmin, deleteAdminBookingSession);
router.get('/payments', requireAdmin, listPaymentsQueue);
router.post('/payments/:paymentId/verify', requireAdmin, adminVerifyPayment);
router.post('/payments/:paymentId/reject', requireAdmin, adminRejectPayment);
router.get('/finance/summary', requireAdmin, getPaymentSummary);
router.get('/finance/physios', requireAdmin, listPhysiosWalletTable);
router.get('/finance/physios/:id', requireAdmin, getPhysioFinanceDetail);
router.post('/finance/settle-commission', requireAdmin, postSettleCommission);
router.get('/platform/settings', requireAdmin, getAdminPlatformSettings);
router.patch('/platform/settings', requireAdmin, patchAdminPlatformSettings);
router.post('/platform/physio-nda', requireAdmin, uploadPhysioNdaTemplate);

export default router;
