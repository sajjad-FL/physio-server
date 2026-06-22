import axios from 'axios';

const AUTHKEY_URL = 'https://api.authkey.io/request';

export function isAuthKeyConfigured() {
  return Boolean(process.env.AUTHKEY_API_KEY && process.env.AUTHKEY_SID);
}

/**
 * Send a 4-digit OTP SMS via AuthKey.io.
 * @param {{ mobile: string, otp: string }} opts — mobile: 10-digit Indian number
 */
export async function sendAuthKeyOtp({ mobile, otp}) {
  const authkey = process.env.AUTHKEY_API_KEY;
  const sid = process.env.AUTHKEY_SID;
  if (!authkey || !sid) {
    throw new Error('SMS OTP is not configured on this server.');
  }

  const response = await axios.get(AUTHKEY_URL, {
    params: {
      authkey,
      mobile: String(mobile).replace(/\D/g, '').slice(-10),
      country_code: process.env.AUTHKEY_COUNTRY_CODE || '91',
      sid,
      otp: String(otp),
      company: process.env.AUTHKEY_COMPANY || 'physioKhom',
    },
    timeout: 15000,
  });
  return response.data;
}
