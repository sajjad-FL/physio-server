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
} from '../controllers/managerController.js';
import { rescheduleBooking, deleteAdminBookingSession } from '../controllers/bookingController.js';

const router = Router();

const managerChain = [
  authenticateJwt,
  requireCompleteProfile,
  requireRoles('care_manager'),
];

router.get('/bookings', ...managerChain, listManagerBookings);
router.get('/bookings/:id', ...managerChain, getManagerBooking);
router.patch('/bookings/:id/assessment', ...managerChain, recordAssessment);
router.patch('/bookings/:id/create-plan', ...managerChain, managerCreatePlan);
router.patch('/bookings/:id/assign-physio', ...managerChain, managerAssignPhysio);
router.post('/bookings/:id/collections', ...managerChain, managerRecordCollection);
router.patch('/bookings/:id/reschedule', ...managerChain, rescheduleBooking);
router.delete('/bookings/:id/sessions/:sessionId', ...managerChain, deleteAdminBookingSession);
router.get('/ledger', ...managerChain, listManagerLedger);
router.get('/zones/me', ...managerChain, listManagerZones);
router.get('/physios', ...managerChain, listZonePhysios);

export default router;
