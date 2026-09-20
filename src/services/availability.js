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
import { OPDToken } from '../models/OPDToken.js';
import { clinicDate } from '../lib/dates.js';
import { BOOKING_HORIZON_DAYS, SHIFT, TOKEN_STATUS } from '../config/constants.js';

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
export const doctorAvailability = async ({ doctor, timezone, now = new Date() }) => {
  const dates = bookableDates(timezone);
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
export const resolveBookableShift = async ({ doctor, date, shift, timezone, now = new Date(), checkCapacity = true }) => {
  const dates = bookableDates(timezone);
  if (!dates.includes(date)) {
    return { ok: false, reason: `Bookings open only for the next ${BOOKING_HORIZON_DAYS} days` };
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
