import cron from 'node-cron';
import { BUSINESS_TIMEZONE } from '../config/slots.js';
import { runPhysioDailyVisitReminders } from './physioDailyVisitReminders.js';

/**
 * Schedules background jobs. Safe to call once after DB connect.
 * Physio daily visit WhatsApp: 03:00 Asia/Kolkata every day.
 */
export function startCronJobs() {
  const enabled =
    String(process.env.CRON_PHYSIO_DAILY_REMINDERS || 'true').toLowerCase() !== 'false';

  if (!enabled) {
    console.log('[cron] Physio daily visit reminders disabled (CRON_PHYSIO_DAILY_REMINDERS=false)');
    return;
  }

  // 3:00 AM every day, India Standard Time
  const expression = String(process.env.CRON_PHYSIO_DAILY_REMINDERS_EXPR || '0 3 * * *').trim();

  if (!cron.validate(expression)) {
    console.error(`[cron] Invalid CRON_PHYSIO_DAILY_REMINDERS_EXPR: ${expression}`);
    return;
  }

  cron.schedule(
    expression,
    () => {
      runPhysioDailyVisitReminders().catch((err) => {
        console.error('[cron][physio-daily] failed:', err?.message || err);
      });
    },
    { timezone: BUSINESS_TIMEZONE },
  );

  console.log(
    `[cron] Physio daily visit reminders scheduled: "${expression}" (${BUSINESS_TIMEZONE})`,
  );
}
