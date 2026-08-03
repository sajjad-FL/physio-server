import axios from 'axios';

/** Fast2SMS WhatsApp (Cloud API) — Authorization: API key header */
const FAST2SMS_SEND_URL = 'https://www.fast2sms.com/dev/whatsapp';

const DEFAULT_PHONE_NUMBER_ID = '1274348429090137';
const DEFAULT_OTP_MESSAGE_ID = '26913';
const DEFAULT_PAYMENT_MESSAGE_ID = '26922';
const DEFAULT_APPOINTMENT_MESSAGE_ID = '26916';
const DEFAULT_FEEDBACK_MESSAGE_ID = '26926';
const DEFAULT_UPCOMING_MESSAGE_ID = '26927';

function getApiKey() {
  return String(
    process.env.FAST2SMS_API_KEY ||
      process.env.AUTHKEY_FAST_API_KEY ||
      '',
  ).trim();
}

function getPhoneNumberId() {
  return String(
    process.env.FAST2SMS_PHONE_NUMBER_ID || DEFAULT_PHONE_NUMBER_ID,
  ).trim();
}

export function isWhatsAppConfigured() {
  return Boolean(getApiKey());
}

/** @deprecated use isWhatsAppConfigured — kept for existing imports */
export function isAuthKeyConfigured() {
  return isWhatsAppConfigured();
}

function isFast2SmsSuccess(data) {
  if (data == null) return false;
  if (typeof data === 'string') {
    const lower = data.toLowerCase();
    return lower.includes('success') || lower.includes('sent');
  }
  if (typeof data !== 'object') return false;
  if (data.return === true || data.status === true || data.success === true) return true;
  const msg = Array.isArray(data.message)
    ? data.message.join(' ')
    : String(data.message ?? data.Message ?? '');
  const lower = msg.toLowerCase();
  if (!lower) return false;
  if (lower.includes('fail') || lower.includes('error') || lower.includes('invalid')) return false;
  return lower.includes('success') || lower.includes('sent');
}

/**
 * Send a WhatsApp template via Fast2SMS simple API.
 * @param {{ mobile: string, messageId: string|number, variables?: string[] }} opts
 */
export async function sendFast2SmsTemplate({ mobile, messageId, variables = [] }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('WhatsApp is not configured on this server.');
  }
  const mid = String(messageId || '').trim();
  if (!mid) {
    throw new Error('WhatsApp message_id is missing.');
  }

  const digits = String(mobile).replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) {
    throw new Error('Invalid mobile number for WhatsApp.');
  }

  const params = {
    message_id: mid,
    phone_number_id: getPhoneNumberId(),
    numbers: digits,
  };
  const vars = (variables || []).map((v) => String(v ?? '').replace(/\|/g, '/'));
  if (vars.length) {
    params.variables_values = vars.join('|');
  }

  let data;
  try {
    const response = await axios.get(FAST2SMS_SEND_URL, {
      params,
      timeout: 20000,
      headers: { Authorization: apiKey },
      validateStatus: () => true,
    });
    data = response.data;
  } catch (err) {
    throw new Error(`WhatsApp send failed: ${err?.message || 'Fast2SMS request error'}`);
  }

  if (!isFast2SmsSuccess(data)) {
    const detail =
      (Array.isArray(data?.message) ? data.message.join(' ') : null) ||
      data?.message ||
      data?.Message ||
      (typeof data === 'string' ? data : null) ||
      'Unknown Fast2SMS error';
    throw new Error(`WhatsApp send failed: ${detail}`);
  }

  return data;
}

/** @deprecated alias — Fast2SMS uses ordered variables, not AuthKey bodyValues */
export async function sendAuthKeyTemplate({ mobile, wid, bodyValues = {} }) {
  const ordered = [];
  const keys = Object.keys(bodyValues || {})
    .filter((k) => /^\d+$/.test(String(k)))
    .sort((a, b) => Number(a) - Number(b));
  for (const k of keys) ordered.push(bodyValues[k]);
  if (!ordered.length) {
    for (const [k, v] of Object.entries(bodyValues || {})) {
      if (String(k).startsWith('var')) continue;
      ordered.push(v);
    }
  }
  return sendFast2SmsTemplate({ mobile, messageId: wid, variables: ordered });
}

/**
 * Send OTP via Fast2SMS (physiokhom_auth / message_id 26913).
 */
export async function sendAuthKeyOtp({ mobile, otp }) {
  const messageId =
    process.env.FAST2SMS_MESSAGE_ID_OTP ||
    process.env.AUTHKEY_WID ||
    DEFAULT_OTP_MESSAGE_ID;
  return sendFast2SmsTemplate({
    mobile,
    messageId,
    variables: [String(otp)],
  });
}

export async function sendWhatsAppOtp({ mobile, otp }) {
  return sendAuthKeyOtp({ mobile, otp });
}

function formatAmountLabel(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount || '');
  return `Rs.${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function visitTypeLabel(booking, fallback = 'physiotherapy session') {
  const st = String(booking?.serviceType || '').toLowerCase();
  if (st === 'online') return 'online consultation';
  if (st === 'clinic') return 'clinic visit';
  if (st === 'home') return 'home visit';
  const issue = String(booking?.issue || '').trim();
  if (issue) return issue.slice(0, 60);
  return fallback;
}

function formatApptDate(value) {
  if (!value) return '—';
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatApptTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  return raw;
}

export async function notifyPaymentReceivedWhatsApp({
  phone,
  name,
  amount,
  forLabel,
  booking,
}) {
  if (!isWhatsAppConfigured()) return false;
  const mobile = String(phone || '').replace(/\D/g, '').slice(-10);
  if (mobile.length !== 10) return false;

  const messageId =
    process.env.FAST2SMS_MESSAGE_ID_PAYMENT ||
    process.env.AUTHKEY_WID_PAYMENT_RECEIVED ||
    DEFAULT_PAYMENT_MESSAGE_ID;
  const patientName = String(name || booking?.userId?.name || booking?.name || 'there').trim() || 'there';
  const amountLabel = formatAmountLabel(amount);
  const purpose = String(forLabel || visitTypeLabel(booking)).trim() || 'your physiotherapy session';

  try {
    await sendFast2SmsTemplate({
      mobile,
      messageId,
      variables: [patientName, amountLabel, purpose],
    });
    return true;
  } catch (err) {
    console.warn('[WhatsApp][payment_confirmation]', err?.message || err);
    return false;
  }
}

export async function notifyAppointmentConfirmedWhatsApp({
  phone,
  name,
  bookedWith,
  appointmentType,
  date,
  time,
  booking,
  bookingId,
}) {
  if (!isWhatsAppConfigured()) return false;
  const mobile = String(phone || '').replace(/\D/g, '').slice(-10);
  if (mobile.length !== 10) return false;

  const messageId =
    process.env.FAST2SMS_MESSAGE_ID_APPOINTMENT ||
    process.env.AUTHKEY_WID_APPOINTMENT_CONFIRMED ||
    DEFAULT_APPOINTMENT_MESSAGE_ID;
  const patientName = String(name || booking?.userId?.name || booking?.name || 'there').trim() || 'there';
  const withName =
    String(
      bookedWith ||
        booking?.physioId?.name ||
        booking?.clinicId?.name ||
        'PhysiOkhom',
    ).trim() || 'PhysiOkhom';
  const typeLabel = String(appointmentType || visitTypeLabel(booking)).trim() || 'physiotherapy session';
  const dateLabel = formatApptDate(date || booking?.date);
  const timeLabel = formatApptTime(time || booking?.timeSlot);
  void bookingId;

  try {
    await sendFast2SmsTemplate({
      mobile,
      messageId,
      variables: [patientName, withName, typeLabel, dateLabel, timeLabel],
    });
    return true;
  } catch (err) {
    console.warn('[WhatsApp][appointment_confirmation]', err?.message || err);
    return false;
  }
}

export async function notifyFeedbackSurveyWhatsApp({
  phone,
  experienceLabel,
  booking,
  bookingId,
  sessionLabel,
}) {
  if (!isWhatsAppConfigured()) return false;
  const mobile = String(phone || '').replace(/\D/g, '').slice(-10);
  if (mobile.length !== 10) return false;

  const messageId =
    process.env.FAST2SMS_MESSAGE_ID_FEEDBACK ||
    process.env.AUTHKEY_WID_FEEDBACK_SURVEY ||
    DEFAULT_FEEDBACK_MESSAGE_ID;
  const visit = String(
    experienceLabel ||
      (sessionLabel ? `${sessionLabel} ${visitTypeLabel(booking)}` : visitTypeLabel(booking)) ||
      'physiotherapy',
  )
    .trim()
    .slice(0, 60);
  void bookingId;

  try {
    await sendFast2SmsTemplate({
      mobile,
      messageId,
      variables: [visit || 'physiotherapy'],
    });
    return true;
  } catch (err) {
    console.warn('[WhatsApp][feedback_survey]', err?.message || err);
    return false;
  }
}

export async function notifyPhysioUpcomingVisitWhatsApp({
  phone,
  eventLabel,
  byLabel,
  date,
  time,
  location,
}) {
  if (!isWhatsAppConfigured()) return false;
  const mobile = String(phone || '').replace(/\D/g, '').slice(-10);
  if (mobile.length !== 10) return false;

  const messageId =
    process.env.FAST2SMS_MESSAGE_ID_PHYSIO_UPCOMING ||
    process.env.AUTHKEY_WID_PHYSIO_UPCOMING ||
    DEFAULT_UPCOMING_MESSAGE_ID;

  try {
    await sendFast2SmsTemplate({
      mobile,
      messageId,
      variables: [
        String(eventLabel || 'physiotherapy visit').trim().slice(0, 60),
        String(byLabel || 'PhysiOkhom').trim().slice(0, 60),
        formatApptDate(date),
        formatApptTime(time),
        String(location || 'see app').trim().slice(0, 60),
      ],
    });
    return true;
  } catch (err) {
    console.warn('[WhatsApp][physio_upcoming]', err?.message || err);
    return false;
  }
}
