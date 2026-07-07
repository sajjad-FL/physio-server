/**
 * Platform commission on gross booking amount — flat INR per session.
 * DB-backed via pricingConfig; env vars are fallback when DB unset.
 */
import {
  getPlatformCommissionPerSessionSync,
  getPlatformCommissionPercentSync,
} from '../utils/pricingConfig.js';

export function getPlatformCommissionPerSession() {
  return getPlatformCommissionPerSessionSync();
}

/** @deprecated Derived from per-session rupees; prefer getPlatformCommissionPerSession. */
export function getPlatformCommissionPercent() {
  return getPlatformCommissionPercentSync();
}
