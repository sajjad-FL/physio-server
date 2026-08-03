import User from '../models/User.js';
import Clinic from '../models/Clinic.js';
import {
  isWhatsAppConfigured,
  notifyAppointmentConfirmedWhatsApp,
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
 * - Patient ← appointment confirmation (26916), bookedWith = manager name
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

  if (patient.phone) {
    patientOk = await notifyAppointmentConfirmedWhatsApp({
      phone: patient.phone,
      name: patient.name,
      bookedWith: manager?.name || 'your care manager',
      appointmentType: type,
      date: booking.date,
      time: booking.timeSlot,
      booking,
      bookingId: booking._id,
    });
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

/** Non-blocking wrapper — never throws to the request path. */
export function fireAssignmentWhatsApp(label, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => console.warn(`[WhatsApp][${label}]`, err?.message || err));
}
