import User from '../models/User.js';
import Clinic from '../models/Clinic.js';
import {
  isWhatsAppConfigured,
  notifyAppointmentConfirmedWhatsApp,
  notifyManagerAssignedPatientWhatsApp,
  notifyAdminNewBookingWhatsApp,
  notifyPhysioUpcomingVisitWhatsApp,
} from './authKeyOtp.js';

function visitLabel(booking) {
  const st = String(booking?.serviceType || '').toLowerCase();
  if (st === 'clinic') return 'clinic visit';
  if (st === 'online') return 'online consultation';
  if (st === 'home') return 'home visit';
  return 'physiotherapy visit';
}

function patientLocationLabel(booking) {
  const loc =
    booking?.userId?.location ||
    booking?.userId?.pincode ||
    booking?.pincode ||
    booking?.clinicId?.name ||
    booking?.clinicId?.address ||
    '';
  return String(loc).trim().slice(0, 60) || 'see app';
}

function patientFromBooking(booking) {
  const u = booking?.userId;
  if (u && typeof u === 'object') {
    return {
      phone: u.phone,
      name: u.name || booking?.name || 'there',
    };
  }
  return { phone: null, name: booking?.name || 'there' };
}

function managerFromBooking(booking) {
  const m = booking?.managerId;
  if (m && typeof m === 'object') {
    return { phone: m.phone, name: m.name || 'Care manager' };
  }
  return null;
}

function clinicFromBooking(booking) {
  const c = booking?.clinicId;
  if (c && typeof c === 'object') {
    return {
      _id: c._id,
      phone: c.phone,
      name: c.name || 'Clinic',
      address: c.address,
    };
  }
  return null;
}

/**
 * After care manager is assigned (admin / auto-zone):
 * - Patient ← manager_patient_assigned (28532)
 * - Manager ← upcoming-style (26927), new case reminder
 */
export async function notifyOnManagerAssigned(booking) {
  if (!isWhatsAppConfigured() || !booking?.managerId) return { patient: false, manager: false };

  const patient = patientFromBooking(booking);
  let manager = managerFromBooking(booking);
  if (!manager && booking.managerId) {
    const m = await User.findById(booking.managerId).select('name phone').lean();
    if (m) manager = { phone: m.phone, name: m.name || 'Care manager' };
  }

  const type = visitLabel(booking);
  let patientOk = false;
  let managerOk = false;

  console.log(
    `[WhatsApp][manager-assigned] booking=${booking?._id} patientPhone=${patient.phone ? 'yes' : 'no'} manager=${manager?.name || '?'}`,
  );

  if (patient.phone) {
    patientOk = await notifyManagerAssignedPatientWhatsApp({
      phone: patient.phone,
      name: patient.name,
      managerName: manager?.name || 'your care manager',
      appointmentType: type,
      date: booking.date,
      time: booking.timeSlot,
      booking,
    });
  } else {
    console.warn('[WhatsApp][manager-assigned] skip patient: no phone on booking.userId');
  }

  if (manager?.phone) {
    managerOk = await notifyPhysioUpcomingVisitWhatsApp({
      phone: manager.phone,
      eventLabel: `New case: ${type}`,
      byLabel: patient.name || 'Patient',
      date: booking.date,
      time: booking.timeSlot,
      location: patientLocationLabel(booking),
    });
  }

  return { patient: patientOk, manager: managerOk };
}

async function resolveClinicNotifyPhones(clinic) {
  const phones = [];
  const seen = new Set();
  const push = (raw) => {
    const digits = String(raw || '').replace(/\D/g, '').slice(-10);
    if (digits.length !== 10 || seen.has(digits)) return;
    seen.add(digits);
    phones.push(digits);
  };

  push(clinic?.phone);

  if (clinic?._id) {
    const full = await Clinic.findById(clinic._id).select('phone staffUserIds walletUserId').lean();
    if (full) {
      push(full.phone);
      const ids = [...(full.staffUserIds || [])];
      if (full.walletUserId) ids.push(full.walletUserId);
      if (ids.length) {
        const staff = await User.find({ _id: { $in: ids } }).select('phone').lean();
        for (const s of staff) push(s.phone);
      }
    }
  }

  return phones;
}

/**
 * After clinic is assigned (admin / manager referral):
 * - Patient ← appointment confirmation (26916), bookedWith = clinic name
 * - Clinic phone(s) ← upcoming-style (26927), new booking reminder
 */
export async function notifyOnClinicAssigned(booking) {
  if (!isWhatsAppConfigured() || !booking?.clinicId) {
    return { patient: false, clinic: 0 };
  }

  const patient = patientFromBooking(booking);
  let clinic = clinicFromBooking(booking);
  if (!clinic && booking.clinicId) {
    const c = await Clinic.findById(booking.clinicId).select('name phone address').lean();
    if (c) clinic = { _id: c._id, phone: c.phone, name: c.name || 'Clinic', address: c.address };
  }

  const type = visitLabel(booking);
  let patientOk = false;
  let clinicSent = 0;

  if (patient.phone && clinic) {
    patientOk = await notifyAppointmentConfirmedWhatsApp({
      phone: patient.phone,
      name: patient.name,
      bookedWith: clinic.name || 'PhysiOkhom clinic',
      appointmentType: type,
      date: booking.date,
      time: booking.timeSlot,
      booking,
      bookingId: booking._id,
    });
  }

  if (clinic) {
    const phones = await resolveClinicNotifyPhones(clinic);
    for (const phone of phones) {
      const ok = await notifyPhysioUpcomingVisitWhatsApp({
        phone,
        eventLabel: `New booking: ${type}`,
        byLabel: patient.name || 'Patient',
        date: booking.date,
        time: booking.timeSlot,
        location: String(clinic.name || clinic.address || 'Clinic').trim().slice(0, 60) || 'Clinic',
      });
      if (ok) clinicSent += 1;
    }
  }

  return { patient: patientOk, clinic: clinicSent };
}

async function resolveAdminNotifyPhones() {
  const phones = [];
  const seen = new Set();
  const push = (raw) => {
    const digits = String(raw || '').replace(/\D/g, '').slice(-10);
    if (digits.length !== 10 || seen.has(digits)) return;
    seen.add(digits);
    phones.push(digits);
  };

  const envList = String(process.env.ADMIN_WHATSAPP_PHONES || process.env.ADMIN_PHONE || '')
    .split(/[,;\s]+/)
    .filter(Boolean);
  for (const p of envList) push(p);

  const admins = await User.find({ role: 'admin' }).select('phone').lean();
  for (const a of admins) push(a.phone);

  return phones;
}

/**
 * Notify every admin WhatsApp when a patient (or staff) creates a booking.
 * Uses dedicated admin template (FAST2SMS_MESSAGE_ID_ADMIN_BOOKING) when configured.
 */
export async function notifyAdminOnNewBooking(booking) {
  if (!isWhatsAppConfigured() || !booking) return 0;

  let patient = patientFromBooking(booking);
  let locationBooking = booking;
  if (booking.userId && (typeof booking.userId !== 'object' || !booking.userId.phone)) {
    const id =
      typeof booking.userId === 'object' && booking.userId?._id
        ? booking.userId._id
        : booking.userId;
    const u = await User.findById(id).select('name phone location pincode').lean();
    if (u) {
      patient = { phone: u.phone, name: u.name || patient.name };
      locationBooking = { ...booking, userId: u };
    }
  }

  const phones = await resolveAdminNotifyPhones();
  if (!phones.length) {
    console.warn('[WhatsApp][admin-new-booking] no admin phone configured — set ADMIN_WHATSAPP_PHONES in .env');
    return 0;
  }

  const bookingRef = booking.bookingCode || booking._id || '';
  const type = visitLabel(booking);
  console.log(
    `[WhatsApp][admin-new-booking] notifying ${phones.length} admin(s) for ${type}${bookingRef ? ` (${bookingRef})` : ''}`,
  );
  let sent = 0;
  for (const phone of phones) {
    const ok = await notifyAdminNewBookingWhatsApp({
      phone,
      patientName: patient.name || 'Patient',
      serviceType: type,
      date: booking.date,
      time: booking.timeSlot,
      location: patientLocationLabel(locationBooking),
      bookingId: booking._id || booking.id || booking.bookingCode,
    });
    if (ok) sent += 1;
    else console.warn(`[WhatsApp][admin-new-booking] failed for admin phone ending ${String(phone).slice(-4)}`);
  }
  if (sent > 0) {
    console.log(`[WhatsApp][admin-new-booking] sent to ${sent}/${phones.length} admin(s): ${type}`);
  } else {
    console.warn('[WhatsApp][admin-new-booking] send failed for all admin numbers');
  }
  return sent;
}

/** Fire-and-forget admin WhatsApp for a new booking. */
export function fireAdminNewBookingWhatsApp(booking) {
  fireAssignmentWhatsApp('admin-new-booking', () => notifyAdminOnNewBooking(booking));
}

/** Non-blocking wrapper — never throws to the request path. */
export function fireAssignmentWhatsApp(label, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => console.warn(`[WhatsApp][${label}]`, err?.message || err));
}
