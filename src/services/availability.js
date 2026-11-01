/**
 * What a doctor's next few days actually look like.
 *
 * Two sources, in priority order:
 *   1. schedule[]          — the recurring weekly pattern
 *   2. scheduleOverrides[] — date-specific 'off' and 'extra', which always win
 *
 * Everything downstream (the patient's 7-day picker, the booking guard, the
 * absence sweep) reads availability from here, so there is one answer to
 * "is this doctor sitting then?" rather than three that can disagree.
 */
import { Doctor } from '../models/Doctor.js';
import { Counter } from '../models/Counter.js';
import { tokenCounterId, nextSequence } from '../lib/counters.js';
import { OPDToken } from '../models/OPDToken.js';
import { clinicDate, tzOffsetMinutes } from '../lib/dates.js';
import { BOOKING_HORIZON_DAYS, SHIFT, TOKEN_STATUS } from '../config/constants.js';
import { env } from '../config/env.js';

/** YYYY-MM-DD `days` after `from`, staying in string space to dodge TZ drift. */
export const addDays = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

/** Day of week for a YYYY-MM-DD string. 0 = Sunday, matching schedule.day. */
export const dayOfWeek = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The horizon the patient may book inside, starting today. */
export const bookableDates = (timezone, days = BOOKING_HORIZON_DAYS) => {
  const today = clinicDate(timezone);
  return Array.from({ length: days }, (_, i) => addDays(today, i));
};

/** 'HH:mm' -> minutes since midnight, for ordering and "has it ended?" checks. */
export const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
};

/** Infer a sensible shift label from a start time, when none was given. */
export const shiftFor = (startTime) => {
  const mins = toMinutes(startTime);
  if (mins < 12 * 60) return SHIFT.MORNING;
  if (mins < 17 * 60) return SHIFT.AFTERNOON;
  return SHIFT.EVENING;
};

/**
 * The sittings a doctor has on one date, after overrides are applied.
 *
 * An 'off' override with no shift closes the whole date; with a shift it closes
 * just that sitting. 'extra' opens one the weekly pattern does not have.
 */
export const shiftsOn = (doctor, date) => {
  const overrides = (doctor.scheduleOverrides || []).filter((o) => o.date === date);
  const dayOff = overrides.find((o) => o.kind === 'off' && !o.shift);
  if (dayOff) return [];

  const offShifts = new Set(overrides.filter((o) => o.kind === 'off' && o.shift).map((o) => o.shift));

  const recurring = (doctor.schedule || [])
    .filter((s) => s.day === dayOfWeek(date) && s.isActive !== false)
    .map((s) => ({
      shift: s.shift || shiftFor(s.startTime),
      startTime: s.startTime,
      endTime: s.endTime,
      maxTokens: s.maxTokens ?? null,
      source: 'recurring',
    }));

  const extras = overrides
    .filter((o) => o.kind === 'extra' && o.startTime && o.endTime)
    .map((o) => ({
      shift: o.shift || shiftFor(o.startTime),
      startTime: o.startTime,
      endTime: o.endTime,
      maxTokens: o.maxTokens ?? null,
      source: 'extra',
    }));

  return [...recurring, ...extras]
    .filter((s) => !offShifts.has(s.shift))
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
};

/** Why a date is closed, for the patient UI — an empty day with no reason reads as a bug. */
export const closureReason = (doctor, date) => {
  const o = (doctor.scheduleOverrides || []).find((x) => x.date === date && x.kind === 'off' && !x.shift);
  return o ? (o.reason || 'Doctor unavailable') : null;
};

/**
 * The 7-day calendar for one doctor: every date in the horizon, its sittings,
 * how many are already booked, and whether each is still bookable.
 *
 * Today's past sittings are marked closed rather than hidden — "Morning (ended)"
 * tells a patient why they cannot pick it, where a missing row does not.
 */
export const doctorAvailability = async ({ doctor, timezone, now = new Date(), days = BOOKING_HORIZON_DAYS }) => {
  const dates = bookableDates(timezone, days);
  const today = dates[0];
  const nowMinutes = (() => {
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(now);
    return toMinutes(hhmm);
  })();

  // One query for the whole horizon beats one per date.
  const counts = await OPDToken.aggregate([
    {
      $match: {
        doctorId: doctor._id,
        date: { $in: dates },
        status: { $in: [TOKEN_STATUS.WAITING, TOKEN_STATUS.IN_CHAMBER, TOKEN_STATUS.COMPLETED] },
      },
    },
    { $group: { _id: { date: '$date', shift: '$shift' }, n: { $sum: 1 } } },
  ]);
  const booked = new Map(counts.map((c) => [`${c._id.date}|${c._id.shift}`, c.n]));

  return dates.map((date) => {
    const shifts = shiftsOn(doctor, date).map((s) => {
      const ended = date === today && toMinutes(s.endTime) <= nowMinutes;
      const taken = booked.get(`${date}|${s.shift}`) ?? 0;
      // maxTokens is optional: null means the sitting stays open until it ends.
      const isFull = s.maxTokens != null && taken >= s.maxTokens;
      return {
        ...s,
        date,
        booked: taken,
        remaining: s.maxTokens != null ? Math.max(0, s.maxTokens - taken) : null,
        isFull,
        isBookable: !ended && !isFull,
        endedToday: ended,
        // Under way right now: the only time live queue numbers mean anything.
        inProgress: date === today && !ended && toMinutes(s.startTime) <= nowMinutes,
      };
    });

    return {
      date,
      dayOfWeek: dayOfWeek(date),
      isToday: date === today,
      shifts,
      isOpen: shifts.some((s) => s.isBookable),
      closureReason: shifts.length ? null : (closureReason(doctor, date) || 'Not a sitting day'),
    };
  });
};

/**
 * Booking guard. Returns the matching shift, or throws-worthy null with a
 * reason the caller can surface verbatim.
 */
export const resolveBookableShift = async ({
  doctor, date, shift, timezone, now = new Date(), checkCapacity = true, horizonDays = BOOKING_HORIZON_DAYS,
}) => {
  const dates = bookableDates(timezone, horizonDays);
  if (!dates.includes(date)) {
    return { ok: false, reason: `Bookings open only for the next ${horizonDays} days` };
  }

  const shifts = shiftsOn(doctor, date);
  if (!shifts.length) {
    return { ok: false, reason: closureReason(doctor, date) || 'The doctor is not sitting on this date' };
  }

  // With one sitting and no shift named, the choice is unambiguous.
  const match = shift ? shifts.find((s) => s.shift === shift) : (shifts.length === 1 ? shifts[0] : null);
  if (!match) {
    return { ok: false, reason: shift ? 'That sitting is not available on this date' : 'Choose a sitting' };
  }

  if (date === dates[0]) {
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(now);
    if (toMinutes(match.endTime) <= toMinutes(hhmm)) {
      return { ok: false, reason: 'That sitting has already ended today' };
    }
  }

  // The cap is optional, so this only runs for a sitting that declares one.
  // Checked here as well as in the calendar because this is the guard the
  // booking path actually goes through.
  if (checkCapacity && match.maxTokens != null) {
    const taken = await OPDToken.countDocuments({
      doctorId: doctor._id,
      date,
      shift: match.shift,
      status: { $in: [TOKEN_STATUS.WAITING, TOKEN_STATUS.IN_CHAMBER, TOKEN_STATUS.COMPLETED] },
    });
    if (taken >= match.maxTokens) {
      return { ok: false, reason: 'This sitting is fully booked — please pick another date or time' };
    }
  }

  return { ok: true, shift: match };
};

/**
 * Everyone who must move because a doctor went off.
 *
 * Only tokens that have not been seen yet: a COMPLETED consultation is history,
 * and rewriting it would corrupt the day's record.
 */
export const tokensNeedingReschedule = ({ doctorId, date, shift = null }) => {
  const filter = {
    doctorId,
    date,
    status: { $in: [TOKEN_STATUS.WAITING, TOKEN_STATUS.IN_CHAMBER] },
  };
  if (shift) filter.shift = shift;
  return OPDToken.find(filter);
};

/** Convenience for callers that have an id rather than a loaded doctor. */
export const availabilityForDoctorId = async (doctorId, timezone) => {
  const doctor = await Doctor.findById(doctorId).select('schedule scheduleOverrides').lean();
  if (!doctor) return null;
  return doctorAvailability({ doctor: { ...doctor, _id: doctorId }, timezone });
};

/** Minutes since midnight in `timezone` right now. */
const minutesNow = (timezone, now = new Date()) => toMinutes(new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(now));

/**
 * The first sitting in the booking horizon a patient could still take a token
 * for, or null. Synchronous: the caller supplies booked counts keyed
 * "doctorId|date|shift", so a list of doctors costs one aggregate, not one each.
 */
export const nextAvailableSitting = ({ doctor, timezone, booked = new Map(), now = new Date() }) => {
  const dates = bookableDates(timezone);
  const nowMins = minutesNow(timezone, now);
  for (const date of dates) {
    for (const s of shiftsOn(doctor, date)) {
      if (date === dates[0] && toMinutes(s.endTime) <= nowMins) continue;
      const taken = booked.get(`${doctor._id}|${date}|${s.shift}`) ?? 0;
      if (s.maxTokens != null && taken >= s.maxTokens) continue;
      return {
        date,
        shift: s.shift,
        startTime: s.startTime,
        endTime: s.endTime,
        isToday: date === dates[0],
        // Already under way today: "now", rather than a start time in the past.
        inProgress: date === dates[0] && toMinutes(s.startTime) <= nowMins,
      };
    }
  }
  return null;
};

/** 'HH:mm' for minutes since midnight. */
const fromMinutes = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * Every token number in one sitting, with the time it is expected to be
 * seen, so a patient booking online can choose a slot instead of taking
 * whatever number comes next.
 *
 * The times come from the doctor's own average consultation length, which
 * they set on their desk profile: token n is expected at
 * start + (n - 1) × average. Capacity is the sitting's cap when it has one,
 * otherwise as many consultations as fit between start and end.
 *
 * A number is `taken` once any token holds it, cancelled ones included — the
 * unique index keeps a cancelled number, so offering it would only fail.
 * Today, a number is `past` once the queue has moved beyond it or its slot
 * has gone by; offering a 9:10 slot at 11:00 helps nobody.
 */
export const sittingSlots = async ({ doctor, timezone, date, shift, now = new Date() }) => {
  const sitting = shiftsOn(doctor, date).find((s) => s.shift === shift);
  if (!sitting) return null;

  const avg = doctor.avgConsultMinutes || env.MINUTES_PER_CONSULT;
  const start = toMinutes(sitting.startTime);
  const end = toMinutes(sitting.endTime);

  // One serial series per doctor per day. The grid shows this sitting's
  // booked tokens and offers exactly the next serial number — never numbers
  // further ahead, which left gaps in the series.
  const tokens = await OPDToken.find({ doctorId: doctor._id, date, shift })
    .select('tokenNumber status')
    .sort({ tokenNumber: 1 })
    .lean();
  const next = await peekNextTokenNumber(doctor._id, date);
  const live = tokens.filter((t) => t.status !== TOKEN_STATUS.CANCELLED && t.status !== TOKEN_STATUS.RESCHEDULE_NEEDED);
  const capped = sitting.maxTokens != null && live.length >= sitting.maxTokens;

  const today = clinicDate(timezone, now);
  const nowMins = date === today ? minutesNow(timezone, now) : -1;
  const started = date === today && nowMins >= start;
  // Everyone still to be seen in this sitting goes before the next number.
  const ahead = tokens.filter((t) => [TOKEN_STATUS.WAITING, TOKEN_STATUS.IN_CHAMBER].includes(t.status)).length;
  const done = live.length - ahead;
  const nextAt = started ? nowMins + ahead * avg : start + (done + ahead) * avg;

  const slots = tokens
    .filter((t) => t.status !== TOKEN_STATUS.RESCHEDULE_NEEDED)
    .map((t) => ({ number: t.tokenNumber, time: null, status: 'taken' }));
  const nextStatus = capped ? 'full' : nextAt >= end ? 'full' : 'free';
  slots.push({ number: next, time: fromMinutes(Math.min(nextAt, 24 * 60 - 1)), status: nextStatus });
  const capacity = sitting.maxTokens ?? Math.max(1, Math.floor((end - start) / avg));

  return {
    date,
    shift: sitting.shift,
    startTime: sitting.startTime,
    endTime: sitting.endTime,
    avgConsultMinutes: avg,
    capacity,
    capped: sitting.maxTokens != null,
    slots,
    // The next serial number, whatever the clock: what the desk issues to a
    // patient standing there, even when online booking is full.
    next,
    // What an app booking gets: the next serial number, while there is room.
    suggested: nextStatus === 'free' ? next : null,
  };
};

/**
 * The sitting a walk-in at `now` belongs to: the one in progress, else the
 * next one today, else today's last (a doctor running late). Null when the
 * doctor has no sittings that day, which is the arrival-order queue app
 * bookings also use, so both share one counter either way.
 */
export const currentSitting = (doctor, date, timezone, now = new Date()) => {
  const sittings = shiftsOn(doctor, date);
  if (!sittings.length) return null;
  const mins = (((now.getUTCHours() * 60 + now.getUTCMinutes() + tzOffsetMinutes(timezone, now)) % 1440) + 1440) % 1440;
  return sittings.find((s) => mins >= toMinutes(s.startTime) && mins < toMinutes(s.endTime))
    ?? sittings.find((s) => mins < toMinutes(s.startTime))
    ?? sittings[sittings.length - 1];
};

/**
 * Token numbers are one plain series per doctor per day — #1, #2, #3 … in the
 * order tokens are issued, whatever the sitting or the time. Walk-ins, app
 * bookings, follow-ups and reschedules all take the next number from the same
 * counter, past any number already used that day, so the series never repeats
 * and never jumps ahead of the patients actually booked. (Calling order still
 * follows the sittings: callNext sorts by sitting first.)
 */
export const allocateTokenNumber = async ({ doctor, date, session, expiresAt }) => {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const n = await nextSequence(tokenCounterId(doctor._id, date, null), session, { expiresAt });
    // eslint-disable-next-line no-await-in-loop
    if (!(await OPDToken.exists({ doctorId: doctor._id, date, tokenNumber: n }).session(session ?? null))) return n;
  }
};

/** The number allocateTokenNumber would issue next, without taking it. */
export const peekNextTokenNumber = async (doctorId, date) => {
  const [counter, used] = await Promise.all([
    Counter.findById(tokenCounterId(doctorId, date, null)).lean(),
    OPDToken.find({ doctorId, date }).select('tokenNumber').lean(),
  ]);
  const taken = new Set(used.map((t) => t.tokenNumber));
  let next = (counter?.seq ?? 0) + 1;
  while (taken.has(next)) next += 1;
  return next;
};

/** Minutes since midnight now, in the clinic's timezone. */
export const todayMinutes = (timezone, now = new Date()) => minutesNow(timezone, now);
