import { env } from '../config/env.js';

// The clinic day is a YYYY-MM-DD string in the hospital's timezone, ALWAYS
// derived server-side. A receptionist's laptop with a wrong clock must never be
// able to fork the queue onto a different date.
export const clinicDate = (timezone = env.DEFAULT_TIMEZONE, at = new Date()) => {
  // en-CA gives ISO-ordered YYYY-MM-DD, which is exactly the storage format.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
};

// Indian financial year: April 1 to March 31. Receipt sequences reset on it.
export const financialYear = (dateStr) => {
  const [y, m] = String(dateStr).split('-').map(Number);
  return m >= 4 ? `${y}-${String((y + 1) % 100).padStart(2, '0')}` : `${y - 1}-${String(y % 100).padStart(2, '0')}`;
};

// Used as the TTL anchor for per-day token counters so they self-clean.
export const endOfClinicDay = (dateStr, timezone = env.DEFAULT_TIMEZONE) => {
  const offsetMinutes = tzOffsetMinutes(timezone, new Date(`${dateStr}T12:00:00Z`));
  // Local midnight of the NEXT day, expressed as UTC.
  const utcMidnight = Date.parse(`${dateStr}T00:00:00Z`);
  return new Date(utcMidnight + 24 * 60 * 60 * 1000 - offsetMinutes * 60 * 1000);
};

// Minutes that `timezone` is ahead of UTC at the given instant.
export const tzOffsetMinutes = (timezone, at = new Date()) => {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUTC - Math.floor(at.getTime() / 1000) * 1000) / 60000);
};

export const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60_000);

export const ageFrom = (dob) => {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  return Math.floor(diff / (365.2425 * 24 * 60 * 60 * 1000));
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff with jitter for the token-allocation retry loop. Jitter
// matters: without it, colliding writers retry in lockstep and collide again.
export const jitterDelay = (attempt) => Math.round(10 * 2 ** attempt * (0.5 + Math.random()));
