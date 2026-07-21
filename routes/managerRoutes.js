import { Router } from 'express';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';
import {
  listManagerBookings,
  getManagerBooking,
  recordAssessment,
  managerCreatePlan,
  managerAssignPhysio,
  managerRecordCollection,
  listManagerLedger,
  listManagerZones,
  listZonePhysios,
  getManagerWallet,
  listManagerWalletTransactions,
  managerSuggestTechnique,
} from '../controllers/managerController.js';
import { managerAssignClinic, listClinics } from '../controllers/clinicAdminController.js';
import {
  createManagerWithdrawRequest,
  getManagerPendingWithdraw,
} from '../controllers/withdrawController.js';
import { getManagerPaymentQr } from '../controllers/platformSettingsController.js';
import { rescheduleBooking, deleteAdminBookingSession } from '../controllers/bookingController.js';
import { uploadPaymentProof } from '../config/upload.js';
import { createStaffPatient } from '../controllers/staffPatientController.js';

const router = Router();

const managerChain = [
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('care_manager'),
];

router.post('/users', ...managerChain, createStaffPatient);
router.get('/bookings', ...managerChain, listManagerBookings);
router.get('/bookings/:id', ...managerChain, getManagerBooking);
router.patch('/bookings/:id/assessment', ...managerChain, recordAssessment);
router.patch('/bookings/:id/create-plan', ...managerChain, managerCreatePlan);
router.patch('/bookings/:id/assign-physio', ...managerChain, managerAssignPhysio);
router.patch('/bookings/:id/assign-clinic', ...managerChain, managerAssignClinic);
router.get('/clinics', ...managerChain, listClinics);
router.get('/payment-qr', ...managerChain, getManagerPaymentQr);
router.post(
  '/bookings/:id/collections',
  ...managerChain,
  uploadPaymentProof.single('proof'),
  managerRecordCollection,
);
router.post('/bookings/:id/suggest-technique', ...managerChain, managerSuggestTechnique);
router.patch('/bookings/:id/reschedule', ...managerChain, rescheduleBooking);
router.delete('/bookings/:id/sessions/:sessionId', ...managerChain, deleteAdminBookingSession);
router.get('/ledger', ...managerChain, listManagerLedger);
router.get('/wallet', ...managerChain, getManagerWallet);
router.get('/wallet/transactions', ...managerChain, listManagerWalletTransactions);
router.get('/withdraw/pending', ...managerChain, getManagerPendingWithdraw);
router.post('/withdraw', ...managerChain, createManagerWithdrawRequest);
router.get('/zones/me', ...managerChain, listManagerZones);
router.get('/physios', ...managerChain, listZonePhysios);

export default router;
