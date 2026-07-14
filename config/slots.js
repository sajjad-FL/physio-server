/** Business day/slots are always India Standard Time (PhysioKhom operates in Assam). */
export const BUSINESS_TIMEZONE = 'Asia/Kolkata'

export const DAILY_SLOTS = [
  '10:00-11:00',
  '11:00-12:00',
  '12:00-13:00',
  '13:00-14:00',
  '15:00-16:00',
  '16:00-17:00',
  '17:00-18:00',
  '18:00-19:00',
]

/**
 * Current calendar date + clock in Asia/Kolkata (independent of server OS TZ).
 * @returns {{ ymd: string, hour: number, minute: number, totalMinutes: number }}
 */
export function nowInBusinessTz(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(
    fmt
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  )
  const hour = Number(parts.hour)
  const minute = Number(parts.minute)
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
  }
}

export function todayYMDLocal() {
  return nowInBusinessTz().ymd
}

function parseSlotStartMinutes(timeSlot) {
  const m = /^(\d{2}):(\d{2})/.exec(String(timeSlot || '').trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** True if slot start (Kolkata today) has already passed or is now — cannot book. */
export function isSlotStartInPastForToday(timeSlot) {
  const start = parseSlotStartMinutes(timeSlot)
  if (start == null) return false
  return nowInBusinessTz().totalMinutes >= start
}

/**
 * True when the slot's start time is less than 2 hours from now (today only, Kolkata).
 * Patients must book at least 2 hours in advance.
 */
export function isSlotWithin2HoursForToday(timeSlot) {
  const start = parseSlotStartMinutes(timeSlot)
  if (start == null) return false
  return start - nowInBusinessTz().totalMinutes < 2 * 60
}
