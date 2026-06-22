/**
 * Platform commission on gross booking amount (same as marketplace take rate).
 * DB-backed via pricingConfig; env vars are fallback when DB unset.
 */
import { getPlatformCommissionPercentSync } from '../utils/pricingConfig.js';

export function getPlatformCommissionPercent() {
  return getPlatformCommissionPercentSync();
}
