import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      default: null,
    },
    issue: { type: String, required: true, trim: true },
    serviceType: {
      type: String,
      enum: ['online', 'home'],
      default: 'home',
    },

    date: { type: String, required: true, trim: true }, // YYYY-MM-DD
    timeSlot: { type: String, required: true, trim: true }, // e.g. 10:00-11:00

    status: {
      type: String,
      enum: ['pending', 'assigned', 'accepted', 'scheduled', 'completed'],
      default: 'pending',
    },

    paymentStatus: {
      type: String,
      enum: ['pending', 'held', 'released', 'refunded'],
      default: 'pending',
    },

    sessionStatus: {
      type: String,
      enum: ['scheduled', 'completed'],
    },
    planStatus: {
      type: String,
      enum: [
        'requested',
        'proposed',
        'approved',
        'rejected',
        'draft',
        'awaiting_consent',
        'live',
        'cancelled',
      ],
      default: null,
    },
    /** Care-manager operational step (home flow). */
    workflowStatus: {
      type: String,
      enum: [
        'pending_manager_assignment',
        'manager_assigned',
        'assessment_done',
        'awaiting_patient_consent',
        'plan_live',
        'physio_assigned',
        'payment_recorded',
        'in_treatment',
        'completed',
      ],
      default: null,
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceZone',
      default: null,
    },
    pincode: { type: String, trim: true, default: null },
    managerAssignedAt: { type: Date, default: null },
    assessmentNotes: { type: String, trim: true, default: '' },
    assessmentCompletedAt: { type: Date, default: null },
    planCreatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    planCreatedByRole: {
      type: String,
      enum: ['care_manager', 'physio', 'admin', null],
      default: null,
    },
    patientConsentedAt: { type: Date, default: null },
    planLiveAt: { type: Date, default: null },
    physioAssignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    paymentCollectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    paymentCollectionStatus: {
      type: String,
      enum: ['none', 'partial', 'recorded', 'settled'],
      default: 'none',
    },
    sessions: { type: Number, min: 1, default: null },
    schedule: {
      type: [
        new mongoose.Schema(
          {
            date: { type: String, required: true, trim: true },
            time: { type: String, required: true, trim: true },
            notes: {
              text: { type: String, default: '' },
              createdAt: { type: Date, default: null },
              updatedAt: { type: Date, default: null },
            },
            status: {
              type: String,
              enum: ['scheduled', 'completed', 'no_show'],
              default: 'scheduled',
            },
            completedAt: { type: Date, default: null },
            patientConfirmed: { type: Boolean, default: false },
            patientConfirmedAt: { type: Date, default: null },
            paymentAtCompletion: { type: Number, default: 0 },
            completedBy: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'Physiotherapist',
              default: null,
            },
            noShowReason: { type: String, default: '', trim: true },
          },
          { _id: true }
        ),
      ],
      default: [],
    },
    /** When there is no multi-session schedule, notes for the primary visit live here. */
    primarySessionNotes: {
      text: { type: String, default: '' },
      createdAt: { type: Date, default: null },
      updatedAt: { type: Date, default: null },
    },
    totalAmount: { type: Number, min: 0, default: null },
    /** Platform wallet credit applied at checkout (INR); physio split uses gross totalAmount. */
    walletDiscount: { type: Number, default: 0, min: 0 },
    /** True after walletBalance was decremented for walletDiscount. */
    walletDeducted: { type: Boolean, default: false },
    amountPerSession: { type: Number, min: 0, default: null },
    /** Physio's flat per-session rate locked at assignment (manager-led plans). Payout basis. */
    physioRatePerSession: { type: Number, min: 0, default: null },
    /** Flat manager commission per session (INR), snapshot from platform settings at plan creation. */
    managerCommissionPerSession: { type: Number, min: 0, default: null },
    /** Captured straight-line distance between patient and assigned physio at assignment time (km). */
    distanceKmAtAssign: { type: Number, min: 0, default: null },
    /** Extra chargeable km above base radius, computed with floor rule. */
    distanceExtraKm: { type: Number, min: 0, default: 0 },
    /** Surcharge rate used at assignment time (INR per km). */
    distanceSurchargePerKm: { type: Number, min: 0, default: 0 },
    /** Total distance surcharge amount in INR added to booking total. */
    distanceSurchargeAmount: { type: Number, min: 0, default: 0 },
    discountPercent: { type: Number, min: 0, max: 15, default: null },
    /** Full upfront vs milestone-based payments for home plans. */
    homePlanBillingType: {
      type: String,
      enum: ['full', 'installment'],
      default: null,
    },
    homePlanPaymentMode: {
      type: String,
      enum: ['online', 'offline'],
      default: null,
    },
    offlinePaymentVerified: { type: Boolean, default: false },
    /** Set when admin rejects a collected offline payment (status reset to pending). */
    offlinePaymentRejectReason: { type: String, default: '', trim: true },

    consentAccepted: { type: Boolean, default: false },

    heldAt: { type: Date, default: null },
    releaseAt: { type: Date, default: null },

    amountPaise: { type: Number, default: null },
    platformFeePercent: { type: Number, default: null },
    platformFeePaise: { type: Number, default: null },
    physioPayoutPaise: { type: Number, default: null },

    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },

    /**
     * Marketplace payment breakdown (amounts in INR).
     * status: pending → paid (online) | verified (offline cash confirmed).
     */
    payment: {
      mode: { type: String, enum: ['online', 'offline'], default: null },
      status: {
        type: String,
        enum: ['pending', 'paid', 'collected', 'verified', 'refunded'],
        default: 'pending',
      },
      amount: { type: Number, default: null },
      commission: { type: Number, default: null },
      physioEarning: { type: Number, default: null },
    },

    /**
     * Cached sum of verified Payment rows (rupees). Kept in sync by
     * recomputeBookingPaymentRollup whenever an installment changes state.
     * Falls back to 0 when no installments exist.
     */
    totalPaid: { type: Number, default: 0, min: 0 },

    /** Set when payment is confirmed (online verify or offline verification) */
    paidAt: { type: Date, default: null },

    /** Primary session moved via PATCH .../reschedule */
    rescheduled: { type: Boolean, default: false },
    rescheduledAt: { type: Date, default: null },
    previousDate: { type: String, default: null, trim: true },
    previousTimeSlot: { type: String, default: null, trim: true },
  },
  { timestamps: true }
);

// Prevent double-booking for the same physiotherapist and slot.
// Unassigned requests (physioId=null) are intentionally allowed in parallel.
bookingSchema.index(
  { physioId: 1, date: 1, timeSlot: 1 },
  {
    unique: true,
    partialFilterExpression: { physioId: { $type: 'objectId' } },
    name: 'uniq_physio_slot',
  }
);

export default mongoose.model('Booking', bookingSchema);
