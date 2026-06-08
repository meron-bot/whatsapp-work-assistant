import { env } from '../config/env';

/**
 * The "quiet-hours gate" from the agent spec (חלק ד׳): every ASSISTANT-INITIATED
 * message (daily briefings, deadline/follow-up nudges, conflict alerts) is only
 * sent during the owner's working window — Sunday–Thursday, 08:00–19:00 in the
 * owner's timezone. Friday/Saturday are off.
 *
 * Owner-scheduled REMINDERS are deliberately NOT gated by this — those fire at a
 * time the owner explicitly chose, so silencing them would be wrong. The gate is
 * for the assistant's own initiatives only.
 */

/** Active-window bounds (owner's local time). End hour is exclusive. */
export const ACTIVE_START_HOUR = 8;
export const ACTIVE_END_HOUR = 19;

/** Israel work week: Sunday–Thursday. Friday/Saturday are off. */
const OFF_DAYS = new Set(['Fri', 'Sat']);

/** Extract the weekday short name + hour for `date` in the given timezone. */
function localParts(date: Date, timeZone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
  let hour = parseInt(hourStr, 10);
  if (Number.isNaN(hour) || hour === 24) hour = 0; // some ICU builds emit "24" at midnight
  return { weekday, hour };
}

/** True on a work day (Sun–Thu) in the owner's timezone — regardless of hour.
 *  Used to gate the fixed-time daily briefings so they skip Fri/Sat. */
export function isWorkday(date: Date = new Date(), timeZone: string = env().OWNER_TIMEZONE): boolean {
  return !OFF_DAYS.has(localParts(date, timeZone).weekday);
}

/** True inside the full active window (Sun–Thu, 08:00–18:59) in the owner's
 *  timezone. Used to gate opportunistic, non-scheduled proactive nudges. */
export function isWithinActiveHours(
  date: Date = new Date(),
  timeZone: string = env().OWNER_TIMEZONE,
): boolean {
  const { weekday, hour } = localParts(date, timeZone);
  if (OFF_DAYS.has(weekday)) return false;
  return hour >= ACTIVE_START_HOUR && hour < ACTIVE_END_HOUR;
}
