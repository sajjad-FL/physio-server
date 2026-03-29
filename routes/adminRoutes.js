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
} from '../controllers/adminController.js';
import { getAdminBookingById } from '../controllers/bookingController.js';
import {
  getPaymentSummary,
  postSettleCommission,
  listPhysiosWalletTable,
} from '../controllers/paymentAnalyticsController.js';
import { listOfflinePaymentsQueue } from '../controllers/adminPaymentsController.js';

const router = Router();

router.get('/users', requireAdmin, listAdminUsers);
router.post('/physios/from-user', requireAdmin, createPhysioFromUser);
router.get('/physios', requireAdmin, listAdminPhysios);
router.get('/physios/:id', requireAdmin, getAdminPhysioById);
router.patch('/physios/:id', requireAdmin, patchAdminPhysio);
router.delete('/physios/:id', requireAdmin, deleteAdminPhysio);
router.patch('/physios/:id/verify', requireAdmin, verifyAdminPhysio);
router.get('/physio-verifications', requireAdmin, listPhysioVerifications);
router.patch('/physio-verifications/:id', requireAdmin, patchPhysioVerification);
router.get('/disputes', requireAdmin, listDisputes);
router.patch('/disputes/:id', requireAdmin, resolveAdminDispute);
router.get('/bookings/:id', requireAdmin, getAdminBookingById);
router.get('/payments/offline', requireAdmin, listOfflinePaymentsQueue);
router.get('/payments/summary', requireAdmin, getPaymentSummary);
router.get('/payments/physios', requireAdmin, listPhysiosWalletTable);
router.post('/payments/settle-commission', requireAdmin, postSettleCommission);

export default router;
