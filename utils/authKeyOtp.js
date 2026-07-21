import axios from 'axios';

const AUTHKEY_URL = 'https://api.authkey.io/request';
const DEFAULT_WID = '41531';

function isAuthKeySuccess(data) {
  if (data == null) return false;
  if (typeof data === 'string') {
    const lower = data.toLowerCase();
    return lower.includes('success') || lower.includes('submitted');
  }
  if (typeof data !== 'object') return false;
  if (data.LogID != null && String(data.LogID).trim() !== '') return true;
  const msg = String(data.Message ?? data.message ?? data.status ?? '').toLowerCase();
  if (!msg) return false;
  if (msg.includes('fail') || msg.includes('error') || msg.includes('invalid')) return false;
  return msg.includes('success') || msg.includes('submitted');
}

export function isAuthKeyConfigured() {
  return Boolean(process.env.AUTHKEY_API_KEY);
}

/**
 * Send a 4-digit OTP via AuthKey.io WhatsApp template (wid).
 * Template uses {{1}} as the OTP (e.g. "{{1}} is your verification code").
 * Shared by signup (/send-otp, /signup-otp) and forgot-password.
 * @param {{ mobile: string, otp: string }} opts — mobile: 10-digit Indian number
 */
export async function sendAuthKeyOtp({ mobile, otp }) {
  const authkey = process.env.AUTHKEY_API_KEY;
  const wid = String(process.env.AUTHKEY_WID || DEFAULT_WID).trim();
  if (!authkey) {
    throw new Error('WhatsApp OTP is not configured on this server.');
  }

  const digits = String(mobile).replace(/\D/g, '').slice(-10);
  // URLSearchParams keeps numbered template vars (1=otp) reliable; axios object keys can drop them.
  const params = new URLSearchParams({
    authkey,
    mobile: digits,
    country_code: process.env.AUTHKEY_COUNTRY_CODE || '91',
    wid,
  });
  params.set('1', String(otp));

  const response = await axios.get(`${AUTHKEY_URL}?${params.toString()}`, {
    timeout: 15000,
  });

  const data = response.data;
  if (!isAuthKeySuccess(data)) {
    const detail =
      (typeof data === 'object' && data != null && (data.Message || data.message)) ||
      (typeof data === 'string' ? data : null) ||
      'Unknown AuthKey error';
    throw new Error(`WhatsApp OTP send failed: ${detail}`);
  }

  return data;
}
