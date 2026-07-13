const UPI_MAX = 80;
const DISPLAY_NAME_MAX = 120;

/** Basic UPI VPA shape: local@handle (e.g. name@oksbi, 9876543210@ybl). */
const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9]{1,31}$/;

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export function normalizePayoutUpiId(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return { ok: false, message: 'UPI ID is required' };
  }
  if (value.length > UPI_MAX) {
    return { ok: false, message: `UPI ID must be at most ${UPI_MAX} characters` };
  }
  if (!UPI_RE.test(value)) {
    return {
      ok: false,
      message: 'Enter a valid UPI ID (e.g. yourname@oksbi or 9876543210@ybl)',
    };
  }
  return { ok: true, value: value.toLowerCase() };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export function normalizePayoutDisplayName(raw) {
  const value = String(raw ?? '').trim();
  if (value.length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `Display name must be at most ${DISPLAY_NAME_MAX} characters` };
  }
  return { ok: true, value };
}

/**
 * Resolve payout destination for a withdraw request: snapshot first, then live profile.
 * @param {{ payoutUpiId?: string, payoutDisplayName?: string, managerId?: object, physioId?: object }} row
 */
export function resolveWithdrawRequestPayout(row) {
  const snapUpi = String(row?.payoutUpiId || '').trim();
  const snapName = String(row?.payoutDisplayName || '').trim();
  if (snapUpi) {
    return { payoutUpiId: snapUpi, payoutDisplayName: snapName };
  }

  const manager = row?.managerId;
  if (manager && typeof manager === 'object') {
    const profileUpi = String(manager.payoutUpiId || '').trim();
    if (profileUpi) {
      return {
        payoutUpiId: profileUpi,
        payoutDisplayName: String(manager.payoutDisplayName || manager.name || '').trim(),
      };
    }
  }

  const physio = row?.physioId;
  if (physio && typeof physio === 'object') {
    const profileUpi = String(physio.payoutUpiId || '').trim();
    if (profileUpi) {
      return {
        payoutUpiId: profileUpi,
        payoutDisplayName: String(physio.payoutDisplayName || physio.name || '').trim(),
      };
    }
  }

  return { payoutUpiId: '', payoutDisplayName: '' };
}

export { UPI_MAX, DISPLAY_NAME_MAX };
