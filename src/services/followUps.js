/**
 * Doctor-booked follow-ups.
 *
 * When a doctor says "come back in two weeks", the follow-up is booked there
 * and then as a real token in that sitting, so the patient has a place and the
 * sitting's capacity reflects it. Because the patient did not choose the date,
 * they are asked to confirm it:
 *
 *   doctor books  → token WAITING, followUp PENDING, patient messaged
 *   patient: yes  → followUp CONFIRMED (and the clinic is billed for it)
 *   patient: no   → token CANCELLED, followUp DECLINED — the slot frees itself
 *   no answer     → past respondBy the doctor sees "No response" and may
 *                   release it: token CANCELLED, followUp RELEASED
 *
 * A cancelled token no longer counts toward a sitting's maxTokens, so freeing
 * one is exactly what lets another patient book that place.
 */
import { Doctor, Hospital, OPDToken, User } from '../models/index.js';
import { clinicDate, clinicDateTime, ageFrom } from '../lib/dates.js';
import { conflict, notFound, validationError } from '../lib/errors.js';
import { assertDoctorScope, assertTokenScope } from '../middleware/rbac.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { getMessagingProvider } from '../lib/providers/index.js';
import { doctorAvailability, resolveBookableShift } from './availability.js';
import { recordTokenChargeSafe } from './billing.js';
import { allocateToken, transition } from '../modules/queue/service.js';
import { emitQueueSnapshot } from '../realtime/emitters.js';
import {
  FOLLOWUP_STATUS, FOLLOWUP_HORIZON_DAYS, FOLLOWUP_RESPOND_LEAD_HOURS,
  NETWORK_STATE, RESPONSE_CODES, ROLES, TOKEN_SOURCE, TOKEN_STATUS, VISIT_TYPE,
} from '../config/constants.js';

const HOUR = 60 * 60 * 1000;
const SHIFT_LABEL = { MORNING: 'Morning', AFTERNOON: 'Afternoon', EVENING: 'Evening' };

const loadDoctor = async (doctorId) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  const hospital = await Hospital.findById(doctor.hospitalId).lean();
  if (!hospital) throw notFound('Hospital not found');
  return { doctor, hospital };
};

/**
 * When the patient's answer is wanted by: FOLLOWUP_RESPOND_LEAD_HOURS before
 * the sitting starts, but never less than two hours after it was booked — a
 * follow-up booked for tomorrow morning must still give them time to reply.
 */
const respondByFor = ({ date, startTime, timezone, now = new Date() }) => {
  const starts = clinicDateTime(date, startTime || '09:00', timezone);
  const wanted = new Date(starts.getTime() - FOLLOWUP_RESPOND_LEAD_HOURS * HOUR);
  const floor = new Date(now.getTime() + 2 * HOUR);
  return new Date(Math.min(starts.getTime(), Math.max(wanted.getTime(), floor.getTime())));
};

// '14:00' -> '2:00 PM', as the patient reads it everywhere else.
const t12 = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h)) return hhmm || '';
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

const humanDate = (date) => new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
}).format(new Date(`${date}T00:00:00Z`));

/**
 * Best-effort WhatsApp. A follow-up stays booked whether or not the message
 * goes out — it is also on the patient's Bookings screen — so a messaging
 * failure is logged, never thrown.
 */
const notify = async (phone, message) => {
  if (!phone) return;
  try {
    const { driver, settings } = await getMessagingProvider();
    await driver.sendText({ to: phone, message, settings });
  } catch (err) {
    logger.warn({ err: err.message }, 'follow-up: patient message not sent');
  }
};

/** The doctor's sittings across the follow-up horizon, for the date picker. */
export const followUpOptions = async ({ doctorId, actor }) => {
  const { doctor, hospital } = await loadDoctor(doctorId);
  assertDoctorScope(actor, doctor);
  const days = await doctorAvailability({ doctor, timezone: hospital.timezone, days: FOLLOWUP_HORIZON_DAYS });
  const today = clinicDate(hospital.timezone);
  // A follow-up is a later visit by definition; today is not offered.
  return {
    followupWindowDays: doctor.followupWindowDays ?? null,
    days: days.filter((d) => d.date !== today && d.shifts.length),
  };
};

export const scheduleFollowUp = async ({ sourceTokenId, date, shift, note, actor }) => {
  const source = await OPDToken.findById(sourceTokenId);
  if (!source) throw notFound('Consultation not found');
  assertTokenScope(actor, source);
  const { doctor, hospital } = await loadDoctor(source.doctorId);
  assertDoctorScope(actor, doctor);

  if (hospital.networkState !== NETWORK_STATE.ACTIVE) {
    throw conflict('This clinic is not accepting bookings', RESPONSE_CODES.HOSPITAL_NOT_ACTIVE);
  }
  if (![TOKEN_STATUS.IN_CHAMBER, TOKEN_STATUS.COMPLETED].includes(source.status)) {
    throw conflict('A follow-up can only be booked for a patient who has been seen');
  }

  // One live follow-up per consultation. A declined or released one may be
  // replaced — that is the doctor offering another date.
  if (source.followUpTokenId) {
    const existing = await OPDToken.findById(source.followUpTokenId).select('status date').lean();
    if (existing && existing.status === TOKEN_STATUS.WAITING) {
      throw conflict(`A follow-up is already booked for ${humanDate(existing.date)}`);
    }
  }

  const today = clinicDate(hospital.timezone);
  if (date <= today) {
    throw validationError([{ path: 'date', message: 'Pick a date after today' }]);
  }
  const resolved = await resolveBookableShift({
    doctor, date, shift, timezone: hospital.timezone, horizonDays: FOLLOWUP_HORIZON_DAYS,
  });
  if (!resolved.ok) throw conflict(resolved.reason, RESPONSE_CODES.BOOKING_CLOSED);
  const sitting = resolved.shift;

  // Age is recomputed for the new visit; everything else is who was seen.
  const patient = await User.findById(source.patientId).select('dob familyMembers phone').lean();
  const member = source.familyMemberId
    ? (patient?.familyMembers || []).find((m) => String(m._id) === String(source.familyMemberId))
    : null;
  const age = ageFrom(member?.dob || patient?.dob) ?? source.patientSnapshot?.age ?? null;
  const cleanNote = String(note || '').trim().slice(0, 300);
  const now = new Date();

  const created = await allocateToken({
    doctor, hospital, date, shift: sitting.shift,
    fields: {
      startTime: sitting.startTime,
      endTime: sitting.endTime,
      doctorId: doctor._id,
      hospitalId: hospital._id,
      patientId: source.patientId,
      familyMemberId: source.familyMemberId ?? null,
      patientSnapshot: {
        name: source.patientSnapshot?.name,
        phone: source.patientSnapshot?.phone,
        gender: source.patientSnapshot?.gender,
        age,
        complaint: cleanNote || `Follow-up of ${source.date} visit`,
        conditions: source.patientSnapshot?.conditions ?? [],
      },
      visitType: VISIT_TYPE.FOLLOWUP,
      // Same channel as a patient's own booking: it surfaces in their app.
      source: TOKEN_SOURCE.APP,
      status: TOKEN_STATUS.WAITING,
      statusHistory: [{ from: null, to: TOKEN_STATUS.WAITING, at: now, byUserId: actor?.id, reason: 'Follow-up booked by doctor' }],
      isPaid: false,
      bookedBy: actor?.id,
      followUp: {
        status: FOLLOWUP_STATUS.PENDING,
        sourceTokenId: source._id,
        note: cleanNote,
        scheduledBy: actor?.id ?? null,
        scheduledAt: now,
        respondBy: respondByFor({ date, startTime: sitting.startTime, timezone: hospital.timezone, now }),
      },
    },
  });

  await OPDToken.updateOne({ _id: source._id }, { $set: { followUpTokenId: created._id } });

  const link = env.APP_URL ? ` Confirm here: ${env.APP_URL.replace(/\/$/, '')}/p/bookings` : ' Please confirm in the Mediigo app.';
  notify(
    source.patientSnapshot?.phone,
    `${doctor.name} has booked a follow-up for ${source.patientSnapshot?.name || 'you'} on ${humanDate(date)}, `
      + `${SHIFT_LABEL[sitting.shift] || sitting.shift} (${t12(sitting.startTime)}–${t12(sitting.endTime)}) at ${hospital.name}. `
      + `Token #${String(created.tokenNumber).padStart(2, '0')}. Will you be coming?${link}`,
  );

  return created;
};

/** The patient's answer. Declining cancels the token, which frees the place. */
export const respondToFollowUp = async ({ tokenId, attending, actor }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Booking not found');
  assertTokenScope(actor, token);

  const status = token.followUp?.status;
  if (!status) throw conflict('This booking is not a follow-up');
  if (token.status !== TOKEN_STATUS.WAITING) {
    throw conflict(
      status === FOLLOWUP_STATUS.RELEASED
        ? 'The clinic has released this follow-up slot — please book a new visit'
        : 'This follow-up can no longer be changed',
    );
  }
  // Confirming twice is harmless; changing a yes to a no is allowed (plans
  // change), changing a no back is not — the place has already gone.
  if (attending && status === FOLLOWUP_STATUS.CONFIRMED) return token.toObject();

  const now = new Date();
  if (attending) {
    await OPDToken.updateOne(
      { _id: token._id },
      { $set: { 'followUp.status': FOLLOWUP_STATUS.CONFIRMED, 'followUp.respondedAt': now } },
    );
    // Billed on confirmation, not on booking: a slot the doctor offered and
    // nobody took is not a token the clinic used. Idempotent per token.
    const hospital = await Hospital.findById(token.hospitalId).lean();
    if (hospital) recordTokenChargeSafe({ hospital, token: token.toObject() });
    await emitQueueSnapshot(token.doctorId, token.date);
    return OPDToken.findById(token._id).lean();
  }

  await transition(token, TOKEN_STATUS.CANCELLED, { actor, reason: 'Patient cannot attend the follow-up' });
  await OPDToken.updateOne(
    { _id: token._id },
    { $set: { 'followUp.status': FOLLOWUP_STATUS.DECLINED, 'followUp.respondedAt': now } },
  );
  await emitQueueSnapshot(token.doctorId, token.date);
  return OPDToken.findById(token._id).lean();
};

/**
 * Free a follow-up slot the patient has not confirmed.
 *
 * Only a PENDING one: a patient who said yes keeps their place, and if they do
 * not turn up on the day the ordinary skip handles it. Allowed before
 * respondBy too — a doctor who has reached the patient by phone and heard
 * "no" should not have to wait for a deadline.
 */
export const releaseFollowUp = async ({ tokenId, reason, actor }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Booking not found');
  assertTokenScope(actor, token);
  const doctor = await Doctor.findById(token.doctorId).lean();
  assertDoctorScope(actor, doctor);

  if (token.followUp?.status !== FOLLOWUP_STATUS.PENDING || token.status !== TOKEN_STATUS.WAITING) {
    throw conflict(
      token.followUp?.status === FOLLOWUP_STATUS.CONFIRMED
        ? 'The patient has confirmed this follow-up, so the slot stays theirs'
        : 'Only an unconfirmed follow-up can be released',
      RESPONSE_CODES.ILLEGAL_TRANSITION,
    );
  }

  const why = String(reason || '').trim().slice(0, 200) || 'Follow-up slot released — no response from patient';
  await transition(token, TOKEN_STATUS.CANCELLED, { actor, reason: why });
  await OPDToken.updateOne(
    { _id: token._id },
    { $set: { 'followUp.status': FOLLOWUP_STATUS.RELEASED, 'followUp.releasedAt': new Date(), 'followUp.releasedBy': actor?.id ?? null } },
  );
  await emitQueueSnapshot(token.doctorId, token.date);

  notify(
    token.patientSnapshot?.phone,
    `Your follow-up with ${doctor.name} on ${humanDate(token.date)} has been released as we did not hear back. `
      + 'You can book a new visit any time in the Mediigo app.',
  );
  return OPDToken.findById(token._id).lean();
};

/**
 * The doctor's follow-ups from today on, newest decisions included, with the
 * one fact the list is for computed server-side: is this one overdue?
 */
export const listFollowUps = async ({ doctorId, actor }) => {
  const { doctor, hospital } = await loadDoctor(doctorId);
  assertDoctorScope(actor, doctor);
  const today = clinicDate(hospital.timezone);
  const now = Date.now();

  const rows = await OPDToken.find({
    doctorId: doctor._id,
    'followUp.status': { $in: Object.values(FOLLOWUP_STATUS) },
    date: { $gte: today },
  })
    .select('tokenNumber date shift startTime endTime status patientSnapshot followUp visitType')
    .sort({ date: 1, startTime: 1, tokenNumber: 1 })
    .limit(300)
    .lean();

  const sources = await OPDToken.find({ _id: { $in: rows.map((r) => r.followUp.sourceTokenId).filter(Boolean) } })
    .select('date tokenNumber outcome')
    .lean();
  const sourceById = new Map(sources.map((s) => [String(s._id), s]));

  const includePii = [ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN].includes(actor.role);
  return rows.map((t) => {
    const src = sourceById.get(String(t.followUp.sourceTokenId));
    return {
      tokenId: String(t._id),
      tokenNumber: t.tokenNumber,
      date: t.date,
      shift: t.shift,
      startTime: t.startTime,
      endTime: t.endTime,
      tokenStatus: t.status,
      status: t.followUp.status,
      note: t.followUp.note,
      scheduledAt: t.followUp.scheduledAt,
      respondBy: t.followUp.respondBy,
      respondedAt: t.followUp.respondedAt,
      releasedAt: t.followUp.releasedAt,
      // Past the deadline with no answer: the case the release button is for.
      overdue: t.followUp.status === FOLLOWUP_STATUS.PENDING
        && t.status === TOKEN_STATUS.WAITING
        && t.followUp.respondBy && new Date(t.followUp.respondBy).getTime() < now,
      patient: {
        name: t.patientSnapshot?.name ?? '',
        age: t.patientSnapshot?.age ?? null,
        gender: t.patientSnapshot?.gender ?? null,
        ...(includePii ? { phone: t.patientSnapshot?.phone ?? '' } : {}),
      },
      source: src ? { date: src.date, tokenNumber: src.tokenNumber, outcome: src.outcome } : null,
    };
  });
};
