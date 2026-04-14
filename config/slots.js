export const DAILY_SLOTS = [
  '10:00-11:00',
  '11:00-12:00',
  '12:00-13:00',
  '13:00-14:00',
  '15:00-16:00',
  '16:00-17:00',
  '17:00-18:00',
  '18:00-19:00',
];

export function todayYMDLocal() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** True if slot start (local today) has already passed or is now — cannot book. */
export function isSlotStartInPastForToday(timeSlot) {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(String(timeSlot || '').trim());
  if (!m) return false;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const now = new Date();
  const slotStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0);
  return now.getTime() >= slotStart.getTime();
}
