import PlatformSettings from '../models/PlatformSettings.js';
import { distanceKm } from './geo.js';
import {
  ALLOWED_PLAN_SESSION_COUNTS,
  DEFAULT_BOOKING_AMOUNT_RUPEES,
  DEFAULT_DISTANCE_SURCHARGE_BASE_KM,
  DEFAULT_DISTANCE_SURCHARGE_PER_KM,
  DEFAULT_HOME_PLAN_MAX_DISCOUNT_PERCENT,
  DEFAULT_MANAGER_COMMISSION_PER_SESSION,
  DEFAULT_PHYSIO_PRICE_PER_SESSION,
  DEFAULT_PLATFORM_COMMISSION_PER_SESSION,
  DEFAULT_PLAN_MILESTONES,
  DEFAULT_PLAN_TIERS,
  DEFAULT_PLATFORM_COMMISSION_PERCENT,
} from '../constants/pricingDefaults.js';

const SINGLETON_ID = 'singleton';

export const PRICING_MONEY_MAX = 50000;
export const PRICING_PER_KM_MAX = 1000;
export const PRICING_BASE_KM_MAX = 500;

/** @type {null | Awaited<ReturnType<typeof buildSnapshot>>} */
let cache = null;

async function ensureSingletonLean() {
  let doc = await PlatformSettings.findById(SINGLETON_ID).lean();
  if (!doc) {
    await PlatformSettings.create({ _id: SINGLETON_ID });
    doc = await PlatformSettings.findById(SINGLETON_ID).lean();
  }
  return doc;
}

function envDefaultBookingAmount() {
  const n = Number(process.env.DEFAULT_BOOKING_AMOUNT_RUPEES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BOOKING_AMOUNT_RUPEES;
}

function envCommissionPercent() {
  const a = Number(process.env.PLATFORM_COMMISSION_PERCENT);
  if (Number.isFinite(a) && a >= 0 && a <= 100) return a;
  const b = Number(process.env.PLATFORM_FEE_PERCENT);
  if (Number.isFinite(b) && b >= 0 && b <= 100) return b;
  return DEFAULT_PLATFORM_COMMISSION_PERCENT;
}

function envCommissionPerSession(defaultBookingAmountRupees) {
  const direct = Number(process.env.PLATFORM_COMMISSION_PER_SESSION);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  if (defaultBookingAmountRupees > 0) {
    const pct = envCommissionPercent();
    return Math.round(((defaultBookingAmountRupees * pct) / 100 + Number.EPSILON) * 100) / 100;
  }
  return DEFAULT_PLATFORM_COMMISSION_PER_SESSION;
}

function resolvePlatformCommissionPerSession(doc, defaultBookingAmountRupees) {
  const raw = doc?.platformCommissionPerSessionRupees;
  if (raw !== null && raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= PRICING_MONEY_MAX) {
      return Math.round(n * 100) / 100;
    }
  }
  const pct = readPercent(doc, 'platformCommissionPercent', envCommissionPercent());
  return Math.round(((defaultBookingAmountRupees * pct) / 100 + Number.EPSILON) * 100) / 100;
}

function readMoney(doc, field, fallback) {
  const raw = doc?.[field];
  if (raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= PRICING_MONEY_MAX) return Math.round(n * 100) / 100;
  return fallback;
}

function readPercent(doc, field, fallback, max = 100) {
  const raw = doc?.[field];
  if (raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= max) return Math.round(n * 100) / 100;
  return fallback;
}

function normalizeMilestonesMap(raw) {
  const out = {};
  for (const sessions of ALLOWED_PLAN_SESSION_COUNTS) {
    const key = String(sessions);
    const fallback = DEFAULT_PLAN_MILESTONES[sessions] || [];
    const rows = raw?.[key] ?? raw?.[sessions];
    if (!Array.isArray(rows) || rows.length === 0) {
      out[sessions] = fallback.map((r) => ({ ...r }));
      continue;
    }
    const normalized = rows
      .map((r) => ({
        bySession: Math.round(Number(r?.bySession)),
        minCumPct: Number(r?.minCumPct),
      }))
      .filter((r) => Number.isFinite(r.bySession) && r.bySession >= 1 && Number.isFinite(r.minCumPct));
    out[sessions] = normalized.length ? normalized : fallback.map((r) => ({ ...r }));
  }
  return out;
}

function normalizePlanTiers(raw) {
  const bySessions = new Map();
  if (Array.isArray(raw)) {
    for (const t of raw) {
      const sessions = Math.round(Number(t?.sessions));
      if (!ALLOWED_PLAN_SESSION_COUNTS.includes(sessions)) continue;
      bySessions.set(sessions, {
        sessions,
        defaultDiscountPercent: readPercent(t, 'defaultDiscountPercent', 0, 50),
        label: String(t?.label ?? '').trim(),
        badge: String(t?.badge ?? '').trim(),
        description: String(t?.description ?? '').trim(),
      });
    }
  }
  return DEFAULT_PLAN_TIERS.map((def) => {
    const stored = bySessions.get(def.sessions);
    if (!stored) return { ...def };
    return {
      sessions: def.sessions,
      defaultDiscountPercent: stored.defaultDiscountPercent,
      label: stored.label || def.label,
      badge: stored.badge || def.badge,
      description: stored.description || def.description,
    };
  });
}

async function buildSnapshot() {
  const doc = await ensureSingletonLean();
  const defaultBookingAmountRupees = readMoney(
    doc,
    'defaultBookingAmountRupees',
    envDefaultBookingAmount(),
  );
  const platformCommissionPerSessionRupees = resolvePlatformCommissionPerSession(
    doc,
    defaultBookingAmountRupees,
  );
  const platformCommissionPercent =
    defaultBookingAmountRupees > 0
      ? Math.round((platformCommissionPerSessionRupees / defaultBookingAmountRupees) * 10000) / 100
      : envCommissionPercent();
  const distanceSurchargeBaseKm = readPercent(
    doc,
    'distanceSurchargeBaseKm',
    DEFAULT_DISTANCE_SURCHARGE_BASE_KM,
    PRICING_BASE_KM_MAX,
  );
  const distanceSurchargePerKmRupees = readMoney(
    doc,
    'distanceSurchargePerKmRupees',
    DEFAULT_DISTANCE_SURCHARGE_PER_KM,
  );
  const homePlanMaxDiscountPercent = readPercent(
    doc,
    'homePlanMaxDiscountPercent',
    DEFAULT_HOME_PLAN_MAX_DISCOUNT_PERCENT,
    50,
  );
  const defaultPhysioPricePerSession = readMoney(
    doc,
    'defaultPhysioPricePerSession',
    DEFAULT_PHYSIO_PRICE_PER_SESSION,
  );
  const managerCommissionPerSessionRupees = readMoney(
    doc,
    'managerCommissionPerSessionRupees',
    DEFAULT_MANAGER_COMMISSION_PER_SESSION,
  );
  const planTiers = normalizePlanTiers(doc?.planTiers);
  const planMilestones = normalizeMilestonesMap(doc?.planMilestones);
  const allowedPlanSessionCounts = [...ALLOWED_PLAN_SESSION_COUNTS];

  return {
    defaultBookingAmountRupees,
    platformCommissionPerSessionRupees,
    platformCommissionPercent,
    distanceSurchargeBaseKm,
    distanceSurchargePerKmRupees,
    homePlanMaxDiscountPercent,
    defaultPhysioPricePerSession,
    managerCommissionPerSessionRupees,
    allowedPlanSessionCounts,
    planTiers,
    planMilestones,
    pricingUpdatedAt: doc?.pricingUpdatedAt ?? null,
    planTiersUpdatedAt: doc?.planTiersUpdatedAt ?? null,
    planMilestonesUpdatedAt: doc?.planMilestonesUpdatedAt ?? null,
  };
}

export function invalidatePricingCache() {
  cache = null;
}

export async function warmPricingCache() {
  cache = await buildSnapshot();
  return cache;
}

export async function getPricingSnapshot() {
  if (cache) return cache;
  return warmPricingCache();
}

function snapshotOrFallback() {
  if (cache) return cache;
  return {
    defaultBookingAmountRupees: envDefaultBookingAmount(),
    platformCommissionPerSessionRupees: envCommissionPerSession(envDefaultBookingAmount()),
    platformCommissionPercent: envCommissionPercent(),
    distanceSurchargeBaseKm: DEFAULT_DISTANCE_SURCHARGE_BASE_KM,
    distanceSurchargePerKmRupees: DEFAULT_DISTANCE_SURCHARGE_PER_KM,
    homePlanMaxDiscountPercent: DEFAULT_HOME_PLAN_MAX_DISCOUNT_PERCENT,
    defaultPhysioPricePerSession: DEFAULT_PHYSIO_PRICE_PER_SESSION,
    managerCommissionPerSessionRupees: DEFAULT_MANAGER_COMMISSION_PER_SESSION,
    allowedPlanSessionCounts: [...ALLOWED_PLAN_SESSION_COUNTS],
    planTiers: DEFAULT_PLAN_TIERS.map((t) => ({ ...t })),
    planMilestones: normalizeMilestonesMap(null),
  };
}

export function getManagerCommissionPerSessionSync() {
  return snapshotOrFallback().managerCommissionPerSessionRupees;
}

export function getPlatformCommissionPerSessionSync() {
  return snapshotOrFallback().platformCommissionPerSessionRupees;
}

export function getPlatformCommissionPercentSync() {
  return snapshotOrFallback().platformCommissionPercent;
}

export function getDefaultBookingAmountRupeesSync() {
  return snapshotOrFallback().defaultBookingAmountRupees;
}

export function getDistanceSurchargeConfigSync() {
  const s = snapshotOrFallback();
  return {
    baseKm: s.distanceSurchargeBaseKm,
    perKmRupees: s.distanceSurchargePerKmRupees,
  };
}

export function getHomePlanMaxDiscountPercentSync() {
  return snapshotOrFallback().homePlanMaxDiscountPercent;
}

export function getAllowedPlanSessionCountsSync() {
  return snapshotOrFallback().allowedPlanSessionCounts;
}

export function getPlanMilestonesSync(sessionsCount) {
  const map = snapshotOrFallback().planMilestones;
  return map[sessionsCount] ?? null;
}

export function getPlanTierForSessionsSync(sessionsCount) {
  const sessions = Math.round(Number(sessionsCount));
  const tiers = snapshotOrFallback().planTiers || [];
  return tiers.find((t) => Number(t.sessions) === sessions) ?? null;
}

export function resolveHomePlanDiscount({ sessions, billingType }) {
  if (billingType !== 'full') return 0;
  const tier = getPlanTierForSessionsSync(sessions);
  const raw = Number(tier?.defaultDiscountPercent ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  const maxDiscount = getHomePlanMaxDiscountPercentSync();
  const rounded = Math.round(raw * 100) / 100;
  // Tier discount is admin-configured per plan length; cap only guards bad data.
  if (rounded > maxDiscount) return maxDiscount;
  return rounded;
}

export function getRequiredPctForSessionSync(sessionsCount, sessionOrdinal) {
  const milestones = getPlanMilestonesSync(sessionsCount);
  if (!milestones) {
    return sessionsCount === 1 ? 1.0 : 0;
  }
  const applicable = milestones.filter((m) => m.bySession <= sessionOrdinal);
  if (!applicable.length) return 0;
  return Math.max(...applicable.map((m) => m.minCumPct));
}

export function getNextMilestoneHintSync(sessionsCount, paidPct, totalAmount) {
  const milestones = getPlanMilestonesSync(sessionsCount);
  if (!milestones) return null;
  const unmet = milestones.find((m) => paidPct + 1e-6 < m.minCumPct);
  if (!unmet) return null;
  const amtNeeded = Math.max(0, Math.round((unmet.minCumPct - paidPct) * totalAmount * 100) / 100);
  return {
    bySession: unmet.bySession,
    minCumPct: unmet.minCumPct,
    amtNeeded,
    label: `By session ${unmet.bySession}: pay ${Math.round(unmet.minCumPct * 100)}% (₹${amtNeeded} more)`,
  };
}

export async function getPublicPricingSettings() {
  const s = await getPricingSnapshot();
  return {
    defaultBookingAmountRupees: s.defaultBookingAmountRupees,
    platformCommissionPerSessionRupees: s.platformCommissionPerSessionRupees,
    platformCommissionPercent: s.platformCommissionPercent,
    distanceSurchargeBaseKm: s.distanceSurchargeBaseKm,
    distanceSurchargePerKmRupees: s.distanceSurchargePerKmRupees,
    homePlanMaxDiscountPercent: s.homePlanMaxDiscountPercent,
    defaultPhysioPricePerSession: s.defaultPhysioPricePerSession,
    managerCommissionPerSessionRupees: s.managerCommissionPerSessionRupees,
    allowedPlanSessionCounts: s.allowedPlanSessionCounts,
    planTiers: s.planTiers,
    planMilestones: s.planMilestones,
    pricingUpdatedAt: s.pricingUpdatedAt ?? null,
    planTiersUpdatedAt: s.planTiersUpdatedAt ?? null,
  };
}

export async function getAdminPricingSettings() {
  const s = await getPricingSnapshot();
  return {
    ...s,
    defaults: {
      defaultBookingAmountRupees: envDefaultBookingAmount(),
      platformCommissionPerSessionRupees: envCommissionPerSession(envDefaultBookingAmount()),
      platformCommissionPercent: envCommissionPercent(),
      distanceSurchargeBaseKm: DEFAULT_DISTANCE_SURCHARGE_BASE_KM,
      distanceSurchargePerKmRupees: DEFAULT_DISTANCE_SURCHARGE_PER_KM,
      homePlanMaxDiscountPercent: DEFAULT_HOME_PLAN_MAX_DISCOUNT_PERCENT,
      defaultPhysioPricePerSession: DEFAULT_PHYSIO_PRICE_PER_SESSION,
      managerCommissionPerSessionRupees: DEFAULT_MANAGER_COMMISSION_PER_SESSION,
      planTiers: DEFAULT_PLAN_TIERS,
      planMilestones: DEFAULT_PLAN_MILESTONES,
    },
  };
}

function validateMilestonesInput(raw, sessionsCount) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `Milestones for ${sessionsCount}-session plans must be a non-empty array` };
  }
  const rows = raw.map((r) => ({
    bySession: Math.round(Number(r?.bySession)),
    minCumPct: Number(r?.minCumPct),
  }));
  for (const r of rows) {
    if (!Number.isFinite(r.bySession) || r.bySession < 1 || r.bySession > sessionsCount) {
      return { error: `Invalid session number in ${sessionsCount}-day milestones` };
    }
    if (!Number.isFinite(r.minCumPct) || r.minCumPct < 0 || r.minCumPct > 1) {
      return { error: 'Milestone cumulative % must be between 0 and 1' };
    }
  }
  const sorted = [...rows].sort((a, b) => a.bySession - b.bySession);
  let prevPct = -1;
  for (const r of sorted) {
    if (r.minCumPct + 1e-9 < prevPct) {
      return { error: 'Milestone cumulative % must not decrease for later sessions' };
    }
    prevPct = r.minCumPct;
  }
  return { value: sorted };
}

export function normalizePricingPatch(body) {
  const out = {};
  const errors = [];

  if (body?.defaultBookingAmountRupees !== undefined) {
    const n = Number(body.defaultBookingAmountRupees);
    if (!Number.isFinite(n) || n <= 0 || n > PRICING_MONEY_MAX) {
      errors.push('defaultBookingAmountRupees must be between 1 and 50000');
    } else out.defaultBookingAmountRupees = Math.round(n * 100) / 100;
  }

  if (body?.platformCommissionPerSessionRupees !== undefined) {
    const n = Number(body.platformCommissionPerSessionRupees);
    if (!Number.isFinite(n) || n < 0 || n > PRICING_MONEY_MAX) {
      errors.push('platformCommissionPerSessionRupees must be between 0 and 50000');
    } else out.platformCommissionPerSessionRupees = Math.round(n * 100) / 100;
  }

  if (body?.platformCommissionPercent !== undefined) {
    const n = Number(body.platformCommissionPercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      errors.push('platformCommissionPercent must be between 0 and 100');
    } else out.platformCommissionPercent = Math.round(n * 100) / 100;
  }

  if (body?.distanceSurchargeBaseKm !== undefined) {
    const n = Number(body.distanceSurchargeBaseKm);
    if (!Number.isFinite(n) || n < 0 || n > PRICING_BASE_KM_MAX) {
      errors.push(`distanceSurchargeBaseKm must be between 0 and ${PRICING_BASE_KM_MAX}`);
    } else out.distanceSurchargeBaseKm = Math.round(n * 100) / 100;
  }

  if (body?.distanceSurchargePerKmRupees !== undefined) {
    const n = Number(body.distanceSurchargePerKmRupees);
    if (!Number.isFinite(n) || n < 0 || n > PRICING_PER_KM_MAX) {
      errors.push(`distanceSurchargePerKmRupees must be between 0 and ${PRICING_PER_KM_MAX}`);
    } else out.distanceSurchargePerKmRupees = Math.round(n * 100) / 100;
  }

  if (body?.homePlanMaxDiscountPercent !== undefined) {
    const n = Number(body.homePlanMaxDiscountPercent);
    if (!Number.isFinite(n) || n < 0 || n > 50) {
      errors.push('homePlanMaxDiscountPercent must be between 0 and 50');
    } else out.homePlanMaxDiscountPercent = Math.round(n * 100) / 100;
  }

  if (body?.defaultPhysioPricePerSession !== undefined) {
    const n = Number(body.defaultPhysioPricePerSession);
    if (!Number.isFinite(n) || n < 0 || n > PRICING_MONEY_MAX) {
      errors.push('defaultPhysioPricePerSession must be between 0 and 50000');
    } else out.defaultPhysioPricePerSession = Math.round(n * 100) / 100;
  }

  if (body?.managerCommissionPerSessionRupees !== undefined) {
    const n = Number(body.managerCommissionPerSessionRupees);
    if (!Number.isFinite(n) || n < 0 || n > PRICING_MONEY_MAX) {
      errors.push('managerCommissionPerSessionRupees must be between 0 and 50000');
    } else out.managerCommissionPerSessionRupees = Math.round(n * 100) / 100;
  }

  const maxDisc = out.homePlanMaxDiscountPercent ?? getHomePlanMaxDiscountPercentSync();

  if (body?.planTiers !== undefined) {
    if (!Array.isArray(body.planTiers)) {
      errors.push('planTiers must be an array');
    } else {
      const tiers = [];
      for (const sessions of ALLOWED_PLAN_SESSION_COUNTS) {
        const t = body.planTiers.find((x) => Math.round(Number(x?.sessions)) === sessions);
        if (!t) {
          errors.push(`planTiers must include ${sessions}-session tier`);
          continue;
        }
        const d = Number(t.defaultDiscountPercent);
        if (!Number.isFinite(d) || d < 0 || d > maxDisc) {
          errors.push(`Tier ${sessions}: discount must be between 0 and ${maxDisc}`);
        }
        tiers.push({
          sessions,
          defaultDiscountPercent: Math.round(d * 100) / 100,
          label: String(t.label ?? '').trim().slice(0, 80),
          badge: String(t.badge ?? '').trim().slice(0, 40),
          description: String(t.description ?? '').trim().slice(0, 500),
        });
      }
      if (errors.length === 0) out.planTiers = tiers;
    }
  }

  if (body?.planMilestones !== undefined) {
    if (typeof body.planMilestones !== 'object' || body.planMilestones === null) {
      errors.push('planMilestones must be an object');
    } else {
      const map = {};
      for (const sessions of ALLOWED_PLAN_SESSION_COUNTS) {
        const key = String(sessions);
        const raw = body.planMilestones[key] ?? body.planMilestones[sessions];
        const v = validateMilestonesInput(raw, sessions);
        if (v.error) errors.push(v.error);
        else map[key] = v.value;
      }
      if (errors.length === 0) out.planMilestones = map;
    }
  }

  if (errors.length) return { ok: false, errors };
  if (Object.keys(out).length === 0) return { ok: false, errors: ['No valid pricing fields to update'] };
  return { ok: true, value: out };
}

export async function applyPricingPatch(patch) {
  const now = new Date();
  const $set = { ...patch };
  if (
    patch.defaultBookingAmountRupees != null ||
    patch.platformCommissionPerSessionRupees != null ||
    patch.platformCommissionPercent != null ||
    patch.distanceSurchargeBaseKm != null ||
    patch.distanceSurchargePerKmRupees != null ||
    patch.homePlanMaxDiscountPercent != null ||
    patch.defaultPhysioPricePerSession != null ||
    patch.managerCommissionPerSessionRupees != null
  ) {
    $set.pricingUpdatedAt = now;
  }
  if (patch.planTiers != null) $set.planTiersUpdatedAt = now;
  if (patch.planMilestones != null) $set.planMilestonesUpdatedAt = now;

  await PlatformSettings.findByIdAndUpdate(SINGLETON_ID, { $set }, { upsert: true });
  invalidatePricingCache();
  return getAdminPricingSettings();
}

export async function resetPricingToDefaults() {
  await PlatformSettings.findByIdAndUpdate(
    SINGLETON_ID,
    {
      $set: {
        defaultBookingAmountRupees: null,
        platformCommissionPercent: null,
        platformCommissionPerSessionRupees: null,
        distanceSurchargeBaseKm: null,
        distanceSurchargePerKmRupees: null,
        homePlanMaxDiscountPercent: null,
        defaultPhysioPricePerSession: null,
        managerCommissionPerSessionRupees: null,
        planTiers: undefined,
        planMilestones: undefined,
        pricingUpdatedAt: null,
        planTiersUpdatedAt: null,
        planMilestonesUpdatedAt: null,
      },
    },
    { upsert: true },
  );
  invalidatePricingCache();
  return getAdminPricingSettings();
}

/** Compute travel surcharge metadata (same shape as legacy bookingController). */
export function computeDistanceSurcharge(patientCoords, physioCoords) {
  const { baseKm, perKmRupees } = getDistanceSurchargeConfigSync();
  const parseLatLng = (coords) => {
    if (!coords || typeof coords !== 'object') return null;
    const lat = Number(coords.lat);
    const lng = Number(coords.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  };
  const patient = parseLatLng(patientCoords);
  const physio = parseLatLng(physioCoords);
  if (!patient || !physio) {
    return {
      distanceKmAtAssign: null,
      distanceExtraKm: 0,
      distanceSurchargePerKm: 0,
      distanceSurchargeAmount: 0,
    };
  }
  const km = distanceKm(patient.lat, patient.lng, physio.lat, physio.lng);
  const floored = Math.floor(km);
  const extraKm = Math.max(0, floored - baseKm);
  const surcharge = extraKm * perKmRupees;
  return {
    distanceKmAtAssign: km,
    distanceExtraKm: extraKm,
    distanceSurchargePerKm: extraKm > 0 ? perKmRupees : 0,
    distanceSurchargeAmount: surcharge,
  };
}
