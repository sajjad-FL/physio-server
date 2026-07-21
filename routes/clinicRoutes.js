import { Router } from 'express';
import { authenticateJwt } from '../middleware/authenticateJwt.js';
import { requireCompleteProfile } from '../middleware/requireCompleteProfile.js';
import { requireRoles } from '../middleware/rbacMiddleware.js';
import {
  getMyClinic,
  listClinicBookings,
  getClinicBooking,
  clinicAssignPhysio,
  listClinicPhysios,
  clinicRecordCollection,
  listClinicLedger,
  getClinicWallet,
  listClinicWalletTransactions,
  updateClinicPayout,
  createClinicWithdrawRequest,
  getClinicPendingWithdraw,
  listClinicPatients,
  createClinicPatient,
  listClinicStaffMembers,
  addClinicStaffMember,
  removeClinicStaffMember,
} from '../controllers/clinicController.js';
import { getManagerPaymentQr } from '../controllers/platformSettingsController.js';
import { uploadPaymentProof } from '../config/upload.js';

const router = Router();

const clinicChain = [authenticateJwt, requireCompleteProfile, requireRoles('clinic_staff')];

router.get('/patients', ...clinicChain, listClinicPatients);
router.post('/patients', ...clinicChain, createClinicPatient);
router.post('/users', ...clinicChain, createClinicPatient);
router.get('/staff', ...clinicChain, listClinicStaffMembers);
router.post('/staff', ...clinicChain, addClinicStaffMember);
router.delete('/staff/:userId', ...clinicChain, removeClinicStaffMember);
router.get('/me', ...clinicChain, getMyClinic);
router.get('/bookings', ...clinicChain, listClinicBookings);
router.get('/bookings/:id', ...clinicChain, getClinicBooking);
router.patch('/bookings/:id/assign-physio', ...clinicChain, clinicAssignPhysio);
router.post(
  '/bookings/:id/collections',
  ...clinicChain,
  uploadPaymentProof.single('proof'),
  clinicRecordCollection,
);
router.get('/physios', ...clinicChain, listClinicPhysios);
router.get('/ledger', ...clinicChain, listClinicLedger);
router.get('/wallet', ...clinicChain, getClinicWallet);
router.get('/wallet/transactions', ...clinicChain, listClinicWalletTransactions);
router.patch('/payout', ...clinicChain, updateClinicPayout);
router.get('/withdraw/pending', ...clinicChain, getClinicPendingWithdraw);
router.post('/withdraw', ...clinicChain, createClinicWithdrawRequest);
router.get('/payment-qr', ...clinicChain, getManagerPaymentQr);

export default router;
