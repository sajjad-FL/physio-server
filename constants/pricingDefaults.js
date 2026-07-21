/** Built-in defaults when PlatformSettings pricing fields are unset (env may override some). */

export const DEFAULT_BOOKING_AMOUNT_RUPEES = 500;
/** @deprecated Legacy percent default; new installs use DEFAULT_PLATFORM_COMMISSION_PER_SESSION. */
export const DEFAULT_PLATFORM_COMMISSION_PERCENT = 20;
/** Flat platform commission per session (INR). */
export const DEFAULT_PLATFORM_COMMISSION_PER_SESSION = 100;
export const DEFAULT_DISTANCE_SURCHARGE_BASE_KM = 5;
export const DEFAULT_DISTANCE_SURCHARGE_PER_KM = 5;
export const DEFAULT_HOME_PLAN_MAX_DISCOUNT_PERCENT = 15;
export const DEFAULT_PHYSIO_PRICE_PER_SESSION = 500;
/** Flat care-manager commission per session (INR). 0 = manager commission disabled. */
export const DEFAULT_MANAGER_COMMISSION_PER_SESSION = 0;
/** Flat clinic commission per session (INR) for clinic visits. */
export const DEFAULT_CLINIC_COMMISSION_PER_SESSION = 300;
/** Manager referrer cut on clinic visits when clinicSource=manager_referred. */
export const DEFAULT_CLINIC_MANAGER_COMMISSION_PER_SESSION = 50;
/** Default patient total for a clinic visit session (INR). */
export const DEFAULT_CLINIC_SESSION_TOTAL = 800;

/** Technique issues that use direct home booking (no care manager). */
export const TECHNIQUE_ISSUES = ['Cupping Therapy', 'Dry Needling', 'Kinesio Taping', 'IASTM'];

/** Default session prices (INR) for technique-direct home bookings. */
export const DEFAULT_TECHNIQUE_PRICES = {
  'Cupping Therapy': 800,
  'Dry Needling': 1000,
  'Kinesio Taping': 700,
  IASTM: 900,
};

export const ALLOWED_PLAN_SESSION_COUNTS = [7, 15, 30];

export const DEFAULT_PLAN_TIERS = [
  {
    sessions: 7,
    defaultDiscountPercent: 0,
    label: '7-Day Plan',
    badge: 'STARTER',
    description: '7 daily home sessions. Pay 1 session upfront, 100% by session 5.',
  },
  {
    sessions: 15,
    defaultDiscountPercent: 3.33,
    label: '15-Day Plan',
    badge: 'MOST POPULAR',
    description: '15 sessions. Pay 50% by session 5, 100% by session 12.',
  },
  {
    sessions: 30,
    defaultDiscountPercent: 4.67,
    label: '30-Day Plan',
    badge: 'BEST VALUE',
    description: '30 sessions. Pay 50% by session 10, 75% by session 20, 100% by session 25.',
  },
];

export const DEFAULT_PLAN_MILESTONES = {
  7: [
    { bySession: 1, minCumPct: 1 / 7 },
    { bySession: 5, minCumPct: 1.0 },
  ],
  15: [
    { bySession: 1, minCumPct: 1 / 15 },
    { bySession: 5, minCumPct: 0.5 },
    { bySession: 12, minCumPct: 1.0 },
  ],
  30: [
    { bySession: 1, minCumPct: 1 / 30 },
    { bySession: 10, minCumPct: 0.5 },
    { bySession: 20, minCumPct: 0.75 },
    { bySession: 25, minCumPct: 1.0 },
  ],
};
