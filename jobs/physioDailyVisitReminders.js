import Booking from '../models/Booking.js';
import { todayYMDLocal } from '../config/slots.js';
import { notifyPhysioUpcomingVisitWhatsApp, isWhatsAppConfigured } from '../utils/authKeyOtp.js';

function visitTypeLabel(booking) {
  const st = String(booking?.serviceType || '').toLowerCase();
  if (st === 'online') return 'online consultation';
  if (st === 'clinic') return 'clinic visit';
  if (st === 'home') return 'home visit';
  return 'physiotherapy visit';
}

function visitLocation(booking) {
  const st = String(booking?.serviceType || '').toLowerCase();
  if (st === 'online') return 'Online';
  if (st === 'clinic') {
    return String(booking?.clinicId?.name || booking?.physioId?.location || 'Clinic').trim() || 'Clinic';
  }
  return String(booking?.userId?.location || booking?.physioId?.location || 'Patient home').trim() || 'Patient home';
}

function slotSortKey(time) {
  const raw = String(time || '');
  const m = raw.match(/(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Collect today's incomplete visits for assigned physios (India calendar day).
 * @returns {Promise<Map<string, { physio: object, visits: object[] }>>}
 */
export async function collectPhysioVisitsForDate(ymd = todayYMDLocal()) {
  const bookings = await Booking.find({
    physioId: { $ne: null },
    status: { $nin: ['completed', 'pending'] },
    $or: [
      { date: ymd },
      { schedule: { $elemMatch: { date: ymd } } },
    ],
  })
    .populate('userId', 'name phone location')
    .populate('physioId', 'name phone location')
    .populate('clinicId', 'name')
    .lean();

  /** @type {Map<string, { physio: object, visits: object[] }>} */
  const byPhysio = new Map();

  for (const booking of bookings) {
    const physio = booking.physioId;
    if (!physio?._id || !physio.phone) continue;
    if (booking.sessionStatus === 'completed' && booking.status === 'completed') continue;

    const physioKey = String(physio._id);
    if (!byPhysio.has(physioKey)) {
      byPhysio.set(physioKey, { physio, visits: [] });
    }
    const bucket = byPhysio.get(physioKey);
    const type = visitTypeLabel(booking);
    const location = visitLocation(booking);
    const patientName = String(booking.userId?.name || booking.name || 'Patient').trim() || 'Patient';

    const schedule = Array.isArray(booking.schedule) ? booking.schedule : [];
    if (schedule.length > 0) {
      for (const entry of schedule) {
        if (String(entry.date) !== String(ymd)) continue;
        if (entry.status === 'completed' || entry.status === 'no_show') continue;
        bucket.visits.push({
          bookingId: booking._id,
          eventLabel: type,
          byLabel: patientName,
          date: entry.date,
          time: entry.time || booking.timeSlot,
          location,
        });
      }
    } else if (String(booking.date) === String(ymd) && booking.sessionStatus !== 'completed') {
      bucket.visits.push({
        bookingId: booking._id,
        eventLabel: type,
        byLabel: patientName,
        date: booking.date,
        time: booking.timeSlot,
        location,
      });
    }
  }

  for (const bucket of byPhysio.values()) {
    bucket.visits.sort((a, b) => slotSortKey(a.time) - slotSortKey(b.time));
  }

  return byPhysio;
}

/**
 * 3 AM daily job: WhatsApp each physio every place they must visit today.
 * {{1}} includes "Visit i of N" so they know how many stops.
 */
export async function runPhysioDailyVisitReminders({ ymd } = {}) {
  const day = ymd || todayYMDLocal();
  if (!isWhatsAppConfigured()) {
    console.warn('[cron][physio-daily] WhatsApp not configured — skipped');
    return { day, physios: 0, sent: 0, skipped: true };
  }

  const byPhysio = await collectPhysioVisitsForDate(day);
  let sent = 0;
  let failed = 0;

  for (const { physio, visits } of byPhysio.values()) {
    if (!visits.length) continue;
    const total = visits.length;
    for (let i = 0; i < visits.length; i += 1) {
      const v = visits[i];
      const eventLabel = `Visit ${i + 1} of ${total}: ${v.eventLabel}`;
      const ok = await notifyPhysioUpcomingVisitWhatsApp({
        phone: physio.phone,
        eventLabel,
        byLabel: v.byLabel,
        date: v.date,
        time: v.time,
        location: v.location,
      });
      if (ok) sent += 1;
      else failed += 1;
    }
  }

  console.log(
    `[cron][physio-daily] ${day}: physios=${byPhysio.size} sent=${sent} failed=${failed}`,
  );
  return { day, physios: byPhysio.size, sent, failed };
}

/** Optional one-off test: import { runPhysioDailyVisitReminders } from './jobs/physioDailyVisitReminders.js' */
