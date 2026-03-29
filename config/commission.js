/**
 * Platform commission on gross booking amount (same as marketplace take rate).
 * Override with PLATFORM_COMMISSION_PERCENT or legacy PLATFORM_FEE_PERCENT.
 */
export function getPlatformCommissionPercent() {
  const a = Number(process.env.PLATFORM_COMMISSION_PERCENT);
  if (Number.isFinite(a) && a >= 0 && a <= 100) return a;
  const b = Number(process.env.PLATFORM_FEE_PERCENT);
  if (Number.isFinite(b) && b >= 0 && b <= 100) return b;
  return 20;
}
