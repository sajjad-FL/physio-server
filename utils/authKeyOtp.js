import axios from "axios";

/** Fast2SMS WhatsApp (Cloud API) — Authorization: API key header */
const FAST2SMS_SEND_URL = "https://www.fast2sms.com/dev/whatsapp";

const DEFAULT_PHONE_NUMBER_ID = "1274348429090137";
const DEFAULT_OTP_MESSAGE_ID = "26913";
const DEFAULT_PAYMENT_MESSAGE_ID = "26922";
const DEFAULT_APPOINTMENT_MESSAGE_ID = "26916";
const DEFAULT_FEEDBACK_MESSAGE_ID = "26926";
const DEFAULT_UPCOMING_MESSAGE_ID = "26927";
const DEFAULT_ADMIN_BOOKING_MESSAGE_ID = "28373";
const DEFAULT_MANAGER_ASSIGNED_MESSAGE_ID = "28532";
const DEFAULT_RESCHEDULED_MESSAGE_ID = "29721";

function adminBookingMessageId() {
  return String(
    process.env.FAST2SMS_MESSAGE_ID_ADMIN_BOOKING ||
      process.env.AUTHKEY_WID_ADMIN_BOOKING ||
      DEFAULT_ADMIN_BOOKING_MESSAGE_ID,
  ).trim();
}

function getApiKey() {
  return String(
    process.env.FAST2SMS_API_KEY || process.env.AUTHKEY_FAST_API_KEY || "",
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
  if (typeof data === "string") {
    const lower = data.toLowerCase();
    return lower.includes("success") || lower.includes("sent");
  }
  if (typeof data !== "object") return false;
  if (data.return === true || data.status === true || data.success === true)
    return true;
  const msg = Array.isArray(data.message)
    ? data.message.join(" ")
    : String(data.message ?? data.Message ?? "");
  const lower = msg.toLowerCase();
  if (!lower) return false;
  if (
    lower.includes("fail") ||
    lower.includes("error") ||
    lower.includes("invalid")
  )
    return false;
  return lower.includes("success") || lower.includes("sent");
}

/**
 * Send a WhatsApp template via Fast2SMS simple API.
 * @param {{ mobile: string, messageId: string|number, variables?: string[] }} opts
 */
export async function sendFast2SmsTemplate({
  mobile,
  messageId,
  variables = [],
}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("WhatsApp is not configured on this server.");
  }
  const mid = String(messageId || "").trim();
  if (!mid) {
    throw new Error("WhatsApp message_id is missing.");
  }

  const digits = String(mobile).replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) {
    throw new Error("Invalid mobile number for WhatsApp.");
  }

  const params = {
    message_id: mid,
    phone_number_id: getPhoneNumberId(),
    numbers: digits,
  };
  const vars = (variables || []).map((v) =>
    String(v ?? "").replace(/\|/g, "/"),
  );
  if (vars.length) {
    params.variables_values = vars.join("|");
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
    throw new Error(
      `WhatsApp send failed: ${err?.message || "Fast2SMS request error"}`,
    );
  }

  if (!isFast2SmsSuccess(data)) {
    const detail =
      (Array.isArray(data?.message) ? data.message.join(" ") : null) ||
      data?.message ||
      data?.Message ||
      (typeof data === "string" ? data : null) ||
      "Unknown Fast2SMS error";
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
      if (String(k).startsWith("var")) continue;
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
  if (!Number.isFinite(n)) return String(amount || "");
  return `Rs.${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function visitTypeLabel(booking, fallback = "physiotherapy session") {
  const st = String(booking?.serviceType || "").toLowerCase();
  if (st === "online") return "online consultation";
  if (st === "clinic") return "clinic visit";
  if (st === "home") return "home visit";
  const issue = String(booking?.issue || "").trim();
  if (issue) return issue.slice(0, 60);
  return fallback;
}

function formatApptDate(value) {
  if (!value) return "—";
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatApptTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "—";
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
  const mobile = String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);
  if (mobile.length !== 10) return false;

  const messageId =
    process.env.FAST2SMS_MESSAGE_ID_PAYMENT ||
    process.env.AUTHKEY_WID_PAYMENT_RECEIVED ||
    DEFAULT_PAYMENT_MESSAGE_ID;
  const patientName =
    String(name || booking?.userId?.name || booking?.name || "there").trim() ||
    "there";
  const amountLabel = formatAmountLabel(amount);
  const purpose =
    String(forLabel || visitTypeLabel(booking)).trim() ||
    "your physiotherapy session";

  try {
    await sendFast2SmsTemplate({
      mobile,
      messageId,
      variables: [patientName, amountLabel, purpose],
    });
    return true;
  } catch (err) {
    console.warn("[WhatsApp][payment_confirmation]", err?.message || err);
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
  const mobile = String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);
  if (mobile.length !== 10) return false;

  const messageId =
    process.env.FAST2SMS_MESSAGE_ID_APPOINTMENT ||
    process.env.AUTHKEY_WID_APPOINTMENT_CONFIRMED ||
    DEFAULT_APPOINTMENT_MESSAGE_ID;
  const patientName =
    String(name || booking?.userId?.name || booking?.name || "there").trim() ||
    "there";
  const withName =
    String(
      bookedWith ||
        booking?.physioId?.name ||
        booking?.clinicId?.name ||
        "PhysiOkhom",
    ).trim() || "PhysiOkhom";
  const typeLabel =
    String(appointmentType || visitTypeLabel(booking)).trim() ||
    "physiotherapy session";
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
    console.warn("[WhatsApp][appointment_confirmation]", err?.message || err);
    return false;
  }
}

/**
 * Patient WhatsApp after care manager is assigned.
 * Template: manager_patient_assigned_appointment_confirmation_1 (message_id 28532)
 * Body: {{1}} patient · {{2}} manager · {{3}} service · {{4}} date · {{5}} time
 * Button "View details": 6th variable = booking id (Meta Website URL must end with {{1}})
 *   https://physiokhom.com/dashboard/bookings/{{1}}
 */
export async function notifyManagerAssignedPatientWhatsApp({
  phone,
  name,
  managerName,
  appointmentType,
  date,
  time,
  booking,
}) {
  if (!isWhatsAppConfigured()) return false;
  const mobile = String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);
  if (mobile.length !== 10) return false;

  // Prefer Fast2SMS message_id — this is what delivers the approved patient template body.
  const messageId =
    String(
      process.env.FAST2SMS_MESSAGE_ID_MANAGER_ASSIGNED ||
        DEFAULT_MANAGER_ASSIGNED_MESSAGE_ID,
    ).trim() || DEFAULT_MANAGER_ASSIGNED_MESSAGE_ID;
  const templateName =
    process.env.FAST2SMS_MANAGER_ASSIGNED_TEMPLATE_NAME ||
    "manager_patient_assigned_appointment_confirmation_1";
  const languageCodes = String(
    process.env.FAST2SMS_MANAGER_ASSIGNED_LANGUAGE || "en_US,en",
  )
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const patientName =
    String(name || booking?.userId?.name || booking?.name || "there").trim() ||
    "there";
  const cmName =
    String(managerName || "your care manager").trim() || "your care manager";
  const typeLabel =
    String(appointmentType || visitTypeLabel(booking)).trim() || "home visit";
  const issue = String(booking?.issue || "").trim();
  const serviceLabel = issue
    ? `${typeLabel}: ${issue}`.slice(0, 60)
    : typeLabel;
  const dateLabel = formatApptDate(date || booking?.date);
  const timeLabel = formatApptTime(time || booking?.timeSlot);
  const vars = [patientName, cmName, serviceLabel, dateLabel, timeLabel];

  const idSuffix = String(booking?._id || booking?.id || "")
    .trim()
    .replace(/^https?:\/\/[^/]+\/(?:dashboard|admin)\/bookings\//i, "")
    .replace(/^\//, "");

  if (!idSuffix) {
    console.warn(
      "[WhatsApp][manager_assigned_patient] missing booking id — View details button will break",
    );
  }

  // Body + optional dynamic URL button suffix (6th value)
  const variables = idSuffix ? [...vars, idSuffix] : [...vars];

  console.log(
    `[WhatsApp][manager_assigned_patient] sending message_id=${messageId} to=***${mobile.slice(-4)} buttonSuffix=${idSuffix || "(none)"} vars=${JSON.stringify(variables)}`,
  );

  try {
    await sendFast2SmsTemplate({
      mobile,
      messageId,
      variables,
    });
    console.log(
      `[WhatsApp][manager_assigned_patient] ok message_id=${messageId}`,
    );
    return true;
  } catch (err) {
    console.warn(
      "[WhatsApp][manager_assigned_patient] simple API failed, trying Meta CTA:",
      err?.message || err,
    );
  }

  // Fallback only if message_id send fails
  for (const languageCode of languageCodes) {
    try {
      await sendTemplateWithUrlButtonMeta({
        mobile,
        templateName,
        languageCode,
        bodyVars: vars,
        buttonUrlSuffix: idSuffix || undefined,
      });
      console.log(
        `[WhatsApp][manager_assigned_patient] ok via Meta CTA lang=${languageCode} button=${idSuffix || "none"}`,
      );
      return true;
    } catch (metaErr) {
      console.warn(
        `[WhatsApp][manager_assigned_patient] Meta CTA lang=${languageCode} failed:`,
        metaErr?.message || metaErr,
      );
    }
  }

  return false;
}

/**
 * Patient WhatsApp when a visit is rescheduled (physio / manager / admin).
 * Template: appointment_reschedule_1 (message_id 29721)
 * New appointment: {{4}} at {{5}}
 * {{4}} = old date, old time has been rescheduled to new date
 * {{5}} = new time
 */
export async function notifyVisitRescheduledWhatsApp({
  phone,
  name,
  visitType,
  rescheduledBy,
  date,
  time,
  previousDate,
  previousTime,
  booking,
  bookingId,
}) {
  if (!isWhatsAppConfigured()) return false;
  const mobile = String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);
  if (mobile.length !== 10) return false;

  const messageId =
    String(
      process.env.FAST2SMS_MESSAGE_ID_RESCHEDULED ||
        process.env.AUTHKEY_WID_VISIT_RESCHEDULED ||
        DEFAULT_RESCHEDULED_MESSAGE_ID,
    ).trim() || DEFAULT_RESCHEDULED_MESSAGE_ID;
  void bookingId;

  const patientName =
    String(name || booking?.userId?.name || booking?.name || "there").trim() ||
    "there";
  const typeLabel =
    String(visitType || visitTypeLabel(booking))
      .trim()
      .slice(0, 60) || "physiotherapy visit";
  const byLabel =
    String(rescheduledBy || "your physiotherapist")
      .trim()
      .slice(0, 60) || "your physiotherapist";
  const newDate = formatApptDate(date || booking?.date);
  const newTime = formatApptTime(time || booking?.timeSlot);
  const oldDate = previousDate ? formatApptDate(previousDate) : "";
  const oldTime = previousTime ? formatApptTime(previousTime) : "";
  const dateLabel = oldDate
    ? `${oldDate}, ${oldTime} has been rescheduled to ${newDate}`
    : newDate;
  const variables = [patientName, typeLabel, byLabel, dateLabel, newTime];

  console.log(
    `[WhatsApp][visit_rescheduled] sending message_id=${messageId} to=***${mobile.slice(-4)} vars=${JSON.stringify(variables)}`,
  );

  try {
    await sendFast2SmsTemplate({
      mobile,
      messageId,
      variables,
    });
    console.log(`[WhatsApp][visit_rescheduled] ok message_id=${messageId}`);
    return true;
  } catch (err) {
    console.warn("[WhatsApp][visit_rescheduled]", err?.message || err);
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
  const mobile = String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);
  if (mobile.length !== 10) return false;

  const messageId =
    process.env.FAST2SMS_MESSAGE_ID_FEEDBACK ||
    process.env.AUTHKEY_WID_FEEDBACK_SURVEY ||
    DEFAULT_FEEDBACK_MESSAGE_ID;
  const visit = String(
    experienceLabel ||
      (sessionLabel
        ? `${sessionLabel} ${visitTypeLabel(booking)}`
        : visitTypeLabel(booking)) ||
      "physiotherapy",
  )
    .trim()
    .slice(0, 60);
  void bookingId;

  try {
    await sendFast2SmsTemplate({
      mobile,
      messageId,
      variables: [visit || "physiotherapy"],
    });
    return true;
  } catch (err) {
    console.warn("[WhatsApp][feedback_survey]", err?.message || err);
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
  const mobile = String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);
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
        String(eventLabel || "physiotherapy visit")
          .trim()
          .slice(0, 60),
        String(byLabel || "PhysiOkhom")
          .trim()
          .slice(0, 60),
        formatApptDate(date),
        formatApptTime(time),
        String(location || "see app")
          .trim()
          .slice(0, 60),
      ],
    });
    return true;
  } catch (err) {
    console.warn(
      `[WhatsApp][physio_upcoming] to=${mobile}`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * Send a template via Meta Graph format (body + optional dynamic URL button).
 * Required when "View details" is a dynamic CTA — simple GET API does not set the button suffix.
 * @see https://docs.fast2sms.com/reference/sendtemplatectabutton
 */
async function sendTemplateWithUrlButtonMeta({
  mobile,
  templateName,
  languageCode = "en_US",
  bodyVars,
  buttonUrlSuffix,
}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("WhatsApp is not configured on this server.");
  if (!templateName) throw new Error("WhatsApp template name is missing.");

  const phoneNumberId = getPhoneNumberId();
  const to = `91${String(mobile).replace(/\D/g, "").slice(-10)}`;
  const apiVersion = process.env.FAST2SMS_GRAPH_VERSION || "v24.0";

  const components = [
    {
      type: "body",
      parameters: bodyVars.map((text) => ({
        type: "text",
        text: String(text ?? ""),
      })),
    },
  ];
  if (buttonUrlSuffix) {
    const suffix = String(buttonUrlSuffix);
    // Meta Cloud API uses type "text"; some Fast2SMS examples use "payload".
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: suffix }],
    });
  }

  const url = `${FAST2SMS_SEND_URL}/${apiVersion}/${phoneNumberId}/messages`;
  const response = await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    },
    {
      timeout: 20000,
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    },
  );

  const data = response.data;
  if (
    response.status >= 200 &&
    response.status < 300 &&
    data?.messages?.[0]?.id
  ) {
    return data;
  }
  if (isFast2SmsSuccess(data)) return data;

  const detail =
    data?.error?.message ||
    (Array.isArray(data?.message) ? data.message.join(" ") : data?.message) ||
    (typeof data === "string" ? data : null) ||
    `HTTP ${response.status}`;
  throw new Error(`WhatsApp CTA send failed: ${detail}`);
}

async function sendAdminBookingTemplateMeta({
  mobile,
  bodyVars,
  buttonUrlSuffix,
}) {
  return sendTemplateWithUrlButtonMeta({
    mobile,
    templateName:
      process.env.FAST2SMS_ADMIN_BOOKING_TEMPLATE_NAME ||
      "appointment_confirmation_1",
    languageCode: process.env.FAST2SMS_ADMIN_BOOKING_LANGUAGE || "en_US",
    bodyVars,
    buttonUrlSuffix,
  });
}

/**
 * Admin alert when a patient creates a new booking.
 * Template: appointment_confirmation_1 (message_id 28373)
 * Body: {{1}} patient · {{2}} service · {{3}} date · {{4}} time · {{5}} location
 * Button "View details" (dynamic URL): suffix = booking id
 *   Meta Website URL MUST be: https://physiokhom.com/admin/bookings/{{1}}
 *   (not example.com — that domain is baked into the approved template)
 */
export async function notifyAdminNewBookingWhatsApp({
  phone,
  patientName,
  serviceType,
  date,
  time,
  location,
  bookingId,
}) {
  if (!isWhatsAppConfigured()) return false;
  const mobile = String(phone || "")
    .replace(/\D/g, "")
    .slice(-10);
  if (mobile.length !== 10) return false;

  const idSuffix = String(bookingId || "")
    .trim()
    .replace(/^https?:\/\/[^/]+\/admin\/bookings\//i, "")
    .replace(/^\//, "");

  const bodyVars = [
    String(patientName || "Patient")
      .trim()
      .slice(0, 60),
    String(serviceType || "physiotherapy visit")
      .trim()
      .slice(0, 60),
    formatApptDate(date),
    formatApptTime(time),
    String(location || "see app")
      .trim()
      .slice(0, 60),
  ];

  try {
    await sendAdminBookingTemplateMeta({
      mobile,
      bodyVars,
      buttonUrlSuffix: idSuffix || undefined,
    });
    return true;
  } catch (metaErr) {
    console.warn(
      `[WhatsApp][admin_new_booking] Meta CTA failed, trying simple API:`,
      metaErr?.message || metaErr,
    );
    try {
      const variables = [...bodyVars];
      if (idSuffix) variables.push(idSuffix);
      await sendFast2SmsTemplate({
        mobile,
        messageId: adminBookingMessageId() || DEFAULT_ADMIN_BOOKING_MESSAGE_ID,
        variables,
      });
      return true;
    } catch (err) {
      console.warn(
        `[WhatsApp][admin_new_booking] to=${mobile}`,
        err?.message || err,
      );
      return false;
    }
  }
}
