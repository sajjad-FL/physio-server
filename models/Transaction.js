import mongoose from 'mongoose';

const PHYSIO_LEDGER_TYPES = ['online', 'offline', 'settlement', 'withdrawal'];
const PATIENT_PLATFORM_TYPES = ['referral_credit', 'referral_signup_bonus', 'wallet_discount'];
/** Care-manager commission economy: credit at settlement, debit at payout. userId = manager's User id. */
const MANAGER_LEDGER_TYPES = ['manager_commission', 'manager_withdrawal'];
/** Clinic commission economy: credit at settlement, debit at payout. userId = clinic wallet user. */
const CLINIC_LEDGER_TYPES = ['clinic_commission', 'clinic_withdrawal'];

/**
 * Ledger lines — balances are derived: sum(credits) − sum(debits) on posted rows.
 * Types: online | offline | settlement | withdrawal | referral_credit | referral_signup_bonus | wallet_discount | manager_commission | manager_withdrawal | clinic_commission | clinic_withdrawal
 */
const transactionSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Physiotherapist',
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: [
        ...PHYSIO_LEDGER_TYPES,
        ...PATIENT_PLATFORM_TYPES,
        ...MANAGER_LEDGER_TYPES,
        ...CLINIC_LEDGER_TYPES,
      ],
      required: true,
    },
    /** INR — amount for this leg (gross, commission, settlement payment, or reversal). */
    totalAmount: { type: Number, required: true, min: 0 },
    commission: { type: Number, default: 0 },
    physioEarning: { type: Number, default: 0 },
    direction: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
    },
    status: {
      type: String,
      enum: ['posted', 'reversed', 'cancelled'],
      default: 'posted',
      index: true,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

transactionSchema.pre('validate', function requirePhysioForPhysioLedger(next) {
  if (PHYSIO_LEDGER_TYPES.includes(this.type) && !this.physioId) {
    this.invalidate('physioId', 'physioId is required for physio ledger types');
  }
  if (PATIENT_PLATFORM_TYPES.includes(this.type) && !this.userId) {
    this.invalidate('userId', 'userId is required for patient/platform ledger types');
  }
  if (MANAGER_LEDGER_TYPES.includes(this.type) && !this.userId) {
    this.invalidate('userId', 'userId is required for manager ledger types');
  }
  if (CLINIC_LEDGER_TYPES.includes(this.type) && !this.userId) {
    this.invalidate('userId', 'userId is required for clinic ledger types');
  }
  next();
});

transactionSchema.index({ physioId: 1, createdAt: -1 });
transactionSchema.index(
  { bookingId: 1, physioId: 1, type: 1, direction: 1, 'meta.leg': 1, 'meta.paymentId': 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'posted', 'meta.leg': { $type: 'string' } },
    name: 'uniq_posted_leg_per_payment',
  }
);
transactionSchema.index(
  { userId: 1, type: 1, 'meta.referredUserId': 1 },
  {
    unique: true,
    partialFilterExpression: { type: 'referral_credit', status: 'posted' },
    name: 'uniq_referral_credit_per_referred',
  }
);
transactionSchema.index(
  { bookingId: 1, type: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { type: 'wallet_discount', status: 'posted' },
    name: 'uniq_wallet_discount_per_booking',
  }
);
transactionSchema.index(
  { userId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { type: 'referral_signup_bonus', status: 'posted' },
    name: 'uniq_referral_signup_bonus_per_user',
  }
);

export default mongoose.model('Transaction', transactionSchema);
