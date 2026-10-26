import mongoose from 'mongoose';
import { Doctor, Hospital, OPDToken, Transaction, User } from '../../models/index.js';
import { nextSequence, tokenCounterId } from '../../lib/counters.js';
import { clinicDate, endOfClinicDay, addMinutes, jitterDelay, sleep, ageFrom } from '../../lib/dates.js';
import { resolveBookableShift, sittingSlots } from '../../services/availability.js';
import { conflict, notFound, validationError, isDuplicateKey } from '../../lib/errors.js';
import { assertDoctorScope, assertTokenScope, assertHospitalScope } from '../../middleware/rbac.js';
import { buildQueueSnapshot } from '../../services/queueSnapshot.js';
import {
  emitQueueSnapshot, emitCallNext, emitTokenStatusChanged, emitTokenCreated,
  emitDoctorBreak, emitDoctorSession, emitTokenCancelled,
} from '../../realtime/emitters.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import {
  TOKEN_STATUS, TOKEN_SOURCE, NETWORK_STATE, RESPONSE_CODES, ROLES,
  BREAK_REASONS, BREAK_DURATIONS, FOLLOWUP_STATUS, AUDIT_ACTIONS,
} from '../../config/constants.js';
import { recordTokenChargeSafe } from '../../services/billing.js';

const loadDoctorAndHospital = async (doctorId) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  const hospital = await Hospital.findById(doctor.hospitalId).lean();
  if (!hospital) throw notFound('Hospital not found');
  return { doctor, hospital };
};

export const getQueue = async ({ doctorId, date, actor }) => {
  const { doctor, hospital } = await loadDoctorAndHospital(doctorId);
  const day = date || clinicDate(hospital.timezone);
  // Staff see real names; everyone else gets the masked public view.
  const staffRoles = [ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN];
  const includePii = Boolean(actor && staffRoles.includes(actor.role));
  return buildQueueSnapshot(doctor._id, day, { includePii });
};

export const transition = async (token, to, { actor, reason, outcome, outcomeNotes } = {}) => {
  const from = token.status;
  const patch = { status: to, $push: undefined };
  const now = new Date();
  if (to === TOKEN_STATUS.IN_CHAMBER) patch.enteredChamberAt = now;
  if (to === TOKEN_STATUS.COMPLETED) {
    patch.completedAt = now;
    // How the consultation ended. Defaults to DONE so a doctor who just taps
    // "next patient" is not forced through a dialog on every single token.
    if (outcome) patch.outcome = outcome;
    if (outcomeNotes !== undefined) patch.outcomeNotes = String(outcomeNotes || '').trim();
  }
  if (to === TOKEN_STATUS.SKIPPED) {
    patch.skippedAt = now;
    patch.skipReason = reason || 'Not present';
  }
  if (to === TOKEN_STATUS.CANCELLED) {
    patch.cancelledAt = now;
    patch.cancelledBy = actor?.id ?? null;
    patch.cancelReason = reason || 'Cancelled';
  }
  delete patch.$push;

  await OPDToken.updateOne(
    { _id: token._id },
    {
      $set: patch,
      $push: { statusHistory: { from, to, at: now, byUserId: actor?.id, reason } },
    },
  );
  const updated = await OPDToken.findById(token._id).lean();
  emitTokenStatusChanged({ token: updated, from, to, reason });
  return updated;
};

/**
 * Put a waiting token in the chamber: the one way a patient goes in, whether
 * by "Call next" or by calling a particular token from the list, so both
 * announce it and both move the doctor's "now serving".
 */
const promoteToChamber = async (token, doctor, actor) => {
  const called = await transition(token, TOKEN_STATUS.IN_CHAMBER, { actor });
  await Doctor.updateOne(
    { _id: doctor._id },
    { $set: { 'session.lastCalledToken': called.tokenNumber, 'session.currentTokenId': called._id } },
  );
  await OPDToken.updateOne({ _id: called._id }, { $set: { calledAt: new Date() } });
  emitCallNext({ token: called, doctor, recall: false });
  return called;
};

/** Refuse a second patient into an occupied chamber, naming who is inside. */
const assertChamberFree = async (doctorId, date, exceptId = null) => {
  const inside = await OPDToken.findOne({
    doctorId, date, status: TOKEN_STATUS.IN_CHAMBER, ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }).select('tokenNumber').lean();
  if (inside) {
    throw conflict(`Token ${String(inside.tokenNumber).padStart(2, '0')} is in the chamber — mark them complete first`, RESPONSE_CODES.CONFLICT);
  }
};

/**
 * Call the next waiting token.
 *
 * Completing the current patient and promoting the next is a single logical
 * step for the doctor, so it happens here rather than requiring two API calls —
 * the prototype's advanceToken() behaviour, but with explicit status history.
 *
 * With nobody left waiting, the patient inside is still finished and the call
 * succeeds with `called: null`: the doctor asked for the consultation to end,
 * and reporting that as a failure (after doing it) leaves the desk guessing.
 */
export const callNext = async ({ doctorId, actor, outcome, outcomeNotes }) => {
  const { doctor, hospital } = await loadDoctorAndHospital(doctorId);
  assertDoctorScope(actor, doctor);
  const date = clinicDate(hospital.timezone);

  if (doctor.session?.isOnBreak) {
    throw conflict('End the break before calling the next patient', RESPONSE_CODES.CONFLICT);
  }

  // Close out whoever is in the chamber — every one of them, should an older
  // client ever have let two in, so the chamber is certainly empty after this.
  const inside = await OPDToken.find({ doctorId: doctor._id, date, status: TOKEN_STATUS.IN_CHAMBER }).sort({ tokenNumber: 1 });
  for (const t of inside) {
    // eslint-disable-next-line no-await-in-loop
    await transition(t, TOKEN_STATUS.COMPLETED, { actor, outcome, outcomeNotes });
  }
  const completed = inside[0] ? { tokenNumber: inside[0].tokenNumber } : null;

  const next = await OPDToken.findOne({ doctorId: doctor._id, date, status: TOKEN_STATUS.WAITING })
    .sort({ tokenNumber: 1 });
  if (!next) {
    await emitQueueSnapshot(doctor._id, date);
    if (completed) return { called: null, completed };
    throw conflict('No patients are waiting', RESPONSE_CODES.CONFLICT);
  }

  const called = await promoteToChamber(next, doctor, actor);
  await emitQueueSnapshot(doctor._id, date);
  return { called, completed };
};

/** Re-announce the current token without changing any state. */
export const recall = async ({ doctorId, actor }) => {
  const { doctor, hospital } = await loadDoctorAndHospital(doctorId);
  assertDoctorScope(actor, doctor);
  const date = clinicDate(hospital.timezone);

  const current = await OPDToken.findOne({ doctorId: doctor._id, date, status: TOKEN_STATUS.IN_CHAMBER });
  if (!current) throw conflict('No patient is currently in the chamber');

  await OPDToken.updateOne({ _id: current._id }, { $inc: { recallCount: 1 } });
  emitCallNext({ token: current, doctor, recall: true });
  return { tokenNumber: current.tokenNumber, recalled: true };
};

export const setTokenStatus = async ({ tokenId, to, reason, actor, outcome, outcomeNotes }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Token not found');
  assertTokenScope(actor, token);

  const legal = {
    [TOKEN_STATUS.WAITING]: [TOKEN_STATUS.IN_CHAMBER, TOKEN_STATUS.SKIPPED],
    [TOKEN_STATUS.IN_CHAMBER]: [TOKEN_STATUS.COMPLETED, TOKEN_STATUS.SKIPPED],
    [TOKEN_STATUS.SKIPPED]: [TOKEN_STATUS.WAITING],
    [TOKEN_STATUS.COMPLETED]: [],
    // Terminal, and deliberately listed rather than left to fall through: a
    // cancelled token is not restorable. The patient books again, which gets a
    // new token at the back of the queue — restoring the old one would hand
    // back a place they gave up.
    [TOKEN_STATUS.CANCELLED]: [],
  };
  if (!legal[token.status]?.includes(to)) {
    throw conflict(`Cannot move a token from ${token.status} to ${to}`, RESPONSE_CODES.ILLEGAL_TRANSITION);
  }

  // Calling a particular token from the list is still a call: one patient
  // in the chamber at a time, announced like "Call next".
  if (to === TOKEN_STATUS.IN_CHAMBER) {
    await assertChamberFree(token.doctorId, token.date, token._id);
    const { doctor } = await loadDoctorAndHospital(token.doctorId);
    if (doctor.session?.isOnBreak) throw conflict('End the break before calling a patient', RESPONSE_CODES.CONFLICT);
    const called = await promoteToChamber(token, doctor, actor);
    await emitQueueSnapshot(token.doctorId, token.date);
    return called;
  }

  const updated = await transition(token, to, { actor, reason, outcome, outcomeNotes });
  await emitQueueSnapshot(token.doctorId, token.date);
  return updated;
};

/** Recall a skipped patient back into the waiting list. */
export const restoreSkipped = async ({ tokenId, actor }) =>
  setTokenStatus({ tokenId, to: TOKEN_STATUS.WAITING, reason: 'Recalled from skipped drawer', actor });

/**
 * Bring a completed patient back — they returned with reports, or were
 * finished by mistake.
 *
 * Straight into the chamber when it is free, so the doctor can see them now.
 * With someone already inside, they go back to the waiting list instead; their
 * token number is lower than anyone still waiting, so they are called next.
 * Today's tokens only: yesterday's queue is closed and its revenue counted.
 */
export const recallCompleted = async ({ tokenId, actor }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Token not found');
  assertTokenScope(actor, token);
  if (token.status !== TOKEN_STATUS.COMPLETED) throw conflict('Only a completed token can be recalled');
  const { doctor, hospital } = await loadDoctorAndHospital(token.doctorId);
  assertDoctorScope(actor, doctor);
  if (token.date !== clinicDate(hospital.timezone)) throw conflict('Only today’s patients can be recalled');

  const busy = await OPDToken.exists({ doctorId: doctor._id, date: token.date, status: TOKEN_STATUS.IN_CHAMBER });
  const to = busy ? TOKEN_STATUS.WAITING : TOKEN_STATUS.IN_CHAMBER;
  const reason = 'Recalled after completion';

  // Written directly rather than through the transition table: COMPLETED is
  // terminal everywhere else, and this is the one deliberate way back.
  const now = new Date();
  await OPDToken.updateOne(
    { _id: token._id },
    {
      $set: { status: to, completedAt: null, outcome: null, outcomeNotes: '', ...(to === TOKEN_STATUS.IN_CHAMBER ? { enteredChamberAt: now, calledAt: now } : {}) },
      $push: { statusHistory: { from: TOKEN_STATUS.COMPLETED, to, at: now, byUserId: actor?.id, reason } },
    },
  );
  const updated = await OPDToken.findById(token._id).lean();
  emitTokenStatusChanged({ token: updated, from: TOKEN_STATUS.COMPLETED, to, reason });
  if (to === TOKEN_STATUS.IN_CHAMBER) {
    await Doctor.updateOne(
      { _id: doctor._id },
      { $set: { 'session.lastCalledToken': updated.tokenNumber, 'session.currentTokenId': updated._id } },
    );
    emitCallNext({ token: updated, doctor, recall: true });
  }
  await emitQueueSnapshot(doctor._id, token.date);
  return { tokenNumber: updated.tokenNumber, status: to };
};

/**
 * Doctor break.
 *
 * breakUntil is computed SERVER-side from a duration, never accepted from the
 * client — this value drives the wait estimate every waiting patient sees, and
 * client clocks drift.
 */
export const startBreak = async ({ doctorId, reason, minutes, actor }) => {
  const { doctor } = await loadDoctorAndHospital(doctorId);
  assertDoctorScope(actor, doctor, { selfOnly: false });

  if (!BREAK_REASONS.includes(reason)) {
    throw validationError([{ path: 'reason', message: `Reason must be one of: ${BREAK_REASONS.join(', ')}` }]);
  }
  if (!BREAK_DURATIONS.includes(Number(minutes))) {
    throw validationError([{ path: 'minutes', message: `Duration must be one of: ${BREAK_DURATIONS.join(', ')}` }]);
  }

  const breakUntil = addMinutes(new Date(), Number(minutes));
  await Doctor.updateOne(
    { _id: doctor._id },
    { $set: { 'session.isOnBreak': true, 'session.breakReason': reason, 'session.breakUntil': breakUntil } },
  );
  const updated = await Doctor.findById(doctor._id).lean();
  emitDoctorBreak(updated);
  await emitQueueSnapshot(doctor._id, clinicDate());
  return updated.session;
};

export const endBreak = async ({ doctorId, actor }) => {
  const { doctor } = await loadDoctorAndHospital(doctorId);
  assertDoctorScope(actor, doctor, { selfOnly: false });
  await Doctor.updateOne(
    { _id: doctor._id },
    { $set: { 'session.isOnBreak': false, 'session.breakReason': null, 'session.breakUntil': null } },
  );
  const updated = await Doctor.findById(doctor._id).lean();
  emitDoctorBreak(updated);
  await emitQueueSnapshot(doctor._id, clinicDate());
  return updated.session;
};

export const setBookingOpen = async ({ doctorId, isOpen, actor }) => {
  const { doctor } = await loadDoctorAndHospital(doctorId);
  assertDoctorScope(actor, doctor, { selfOnly: false });
  await Doctor.updateOne({ _id: doctor._id }, { $set: { 'session.isBookingOpen': Boolean(isOpen) } });
  const updated = await Doctor.findById(doctor._id).lean();
  emitDoctorSession(updated);
  return updated.session;
};

/**
 * Patient app booking — unpaid, so no Transaction. Uses the same counter
 * allocation and retry loop as the POS.
 */
export const bookToken = async ({ doctorId, patientId, familyMemberId, visitType = 'fresh', date: wantedDate, shift: wantedShift, tokenNumber: wantedNumber, complaint, conditions, actor }) => {
  const { doctor, hospital } = await loadDoctorAndHospital(doctorId);
  if (hospital.networkState !== NETWORK_STATE.ACTIVE) {
    throw conflict('This clinic is not accepting bookings', RESPONSE_CODES.HOSPITAL_NOT_ACTIVE);
  }

  const today = clinicDate(hospital.timezone);
  const date = wantedDate || today;

  // isBookingOpen is a live switch for the doctor sitting right now, so it can
  // only gate today. A future date is governed by the schedule instead — a
  // doctor who has not opened this morning's queue is still sitting on Friday.
  if (date === today && !wantedShift && !doctor.session?.isBookingOpen && !(doctor.schedule || []).length) {
    throw conflict('Bookings are closed for this doctor', RESPONSE_CODES.BOOKING_CLOSED);
  }

  // A doctor with no schedule configured keeps the old walk-in behaviour, so
  // this rolls out without stranding clinics that have not set shifts yet.
  let shift = null;
  let shiftTimes = { startTime: '', endTime: '' };
  if ((doctor.schedule || []).length || (doctor.scheduleOverrides || []).length) {
    const resolved = await resolveBookableShift({ doctor, date, shift: wantedShift, timezone: hospital.timezone });
    if (!resolved.ok) throw conflict(resolved.reason, RESPONSE_CODES.BOOKING_CLOSED);
    shift = resolved.shift.shift;
    shiftTimes = { startTime: resolved.shift.startTime, endTime: resolved.shift.endTime };
  } else if (date !== today) {
    throw conflict('This doctor has no schedule set, so only same-day booking is available', RESPONSE_CODES.BOOKING_CLOSED);
  } else if (!doctor.session?.isBookingOpen) {
    throw conflict('Bookings are closed for this doctor', RESPONSE_CODES.BOOKING_CLOSED);
  }
  // A chosen token number must be one the slot grid offered: inside the
  // sitting, not taken, and not already behind the queue. The insert below
  // still guards the race where two patients pick it at the same moment.
  let fixedNumber = null;
  if (wantedNumber != null) {
    if (!shift) throw conflict('This doctor takes tokens in arrival order only', RESPONSE_CODES.BOOKING_CLOSED);
    const grid = await sittingSlots({ doctor, timezone: hospital.timezone, date, shift });
    const slot = grid?.slots.find((x) => x.number === wantedNumber);
    if (!slot || slot.status !== 'free') {
      throw conflict(`Token ${wantedNumber} is no longer available — please pick another`, RESPONSE_CODES.BOOKING_CLOSED);
    }
    fixedNumber = wantedNumber;
  }

  const patient = await User.findById(patientId).lean();
  if (!patient) throw notFound('Patient not found');

  const member = familyMemberId
    ? (patient.familyMembers || []).find((m) => String(m._id) === String(familyMemberId))
    : null;

  const created = await allocateToken({
    doctor, hospital, date, shift, fixedNumber,
    fields: {
      ...shiftTimes,
      doctorId: doctor._id, hospitalId: hospital._id, patientId: patient._id,
      familyMemberId: member?._id ?? null,
      patientSnapshot: {
        name: member?.name || patient.name,
        phone: patient.phone,
        gender: member?.gender || patient.gender,
        // Frozen at booking: the roster shows the age they were seen at,
        // and a dob edited later must not rewrite an old consultation.
        age: ageFrom(member?.dob || patient.dob),
        complaint: complaint?.trim() || '',
        // Frozen with the rest of the snapshot: what was declared for
        // THIS visit, not whatever the profile says years later.
        conditions: Array.isArray(conditions)
          ? conditions.map((c) => String(c).trim()).filter(Boolean).slice(0, 20)
          : (member?.conditions ?? []),
      },
      visitType, source: TOKEN_SOURCE.APP, status: TOKEN_STATUS.WAITING,
      statusHistory: [{ from: null, to: TOKEN_STATUS.WAITING, at: new Date(), byUserId: actor?.id }],
      isPaid: false, bookedBy: actor?.id ?? patient._id,
    },
  });

  // Platform billing, deliberately AFTER the transaction has committed and
  // deliberately unawaited-on-failure: a clinic's commercial terms must
  // never be the reason a patient cannot get a token.
  recordTokenChargeSafe({ hospital, token: created });
  return created;
};

/**
 * Allocate the next token number in a sitting and create the token, retrying
 * on a number collision. Shared by patient booking and doctor-booked
 * follow-ups, so both go through the same counter and the same unique index.
 */
export const allocateToken = async ({ doctor, hospital, date, shift, fields, fixedNumber = null }) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let created;
      // eslint-disable-next-line no-await-in-loop
      await session.withTransaction(async () => {
        const counter = () => nextSequence(tokenCounterId(doctor._id, date, shift), session, {
          // Anchored to the token's own date, so a counter for a future sitting
          // is not swept away before that day arrives.
          expiresAt: endOfClinicDay(date, hospital.timezone),
        });
        let tokenNumber = fixedNumber;
        if (tokenNumber == null) {
          // Patients booking online may have picked numbers ahead of the
          // counter. Step past those here; leaving it to the duplicate-key
          // retry would exhaust the retries after five picked numbers in a row.
          tokenNumber = await counter();
          // eslint-disable-next-line no-await-in-loop
          while (await OPDToken.exists({ doctorId: doctor._id, date, shift: shift ?? null, tokenNumber }).session(session)) {
            // eslint-disable-next-line no-await-in-loop
            tokenNumber = await counter();
          }
        }
        const [token] = await OPDToken.create(
          [{ ...fields, tokenNumber, date, shift: shift ?? undefined }],
          { session, ordered: true },
        );
        created = token.toObject();
      }, { writeConcern: { w: 'majority' } });

      emitTokenCreated(created);
      // eslint-disable-next-line no-await-in-loop
      await emitQueueSnapshot(doctor._id, date);
      return created;
    } catch (err) {
      // A picked number that someone else got first is the patient's call to
      // make again, not something to retry into a different number silently.
      if (isDuplicateKey(err) && fixedNumber != null) {
        throw conflict(`Token ${fixedNumber} was just taken — please pick another`, RESPONSE_CODES.BOOKING_CLOSED);
      }
      if (isDuplicateKey(err) && attempt < 4) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(jitterDelay(attempt));
        continue;
      }
      throw err;
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await session.endSession();
    }
  }
  throw conflict('Could not allocate a token, please retry', RESPONSE_CODES.TOKEN_ALLOC_EXHAUSTED);
};

/**
 * Cancel a waiting token.
 *
 * CANCELLED, not SKIPPED: a patient who withdrew and a patient who missed
 * their call are different events, and reporting that cannot tell them apart
 * is reporting nobody can act on.
 *
 * No refund, ever — including for a token already paid for at the desk. The
 * patient is told this plainly before they confirm, and nothing here touches
 * the Transaction: the money stays collected and the receipt stays valid.
 * A genuine refund remains a separate, deliberate act at the front desk.
 *
 * Cancelling removes the token from the waiting list, so the doctor's next
 * call simply reaches the following patient, and every published wait time
 * drops by one consultation. Neither needs special handling here: the queue
 * snapshot derives both from the live waiting list, and emitting it is what
 * pushes the corrected timer to every screen.
 */
const CANCEL_ROLE = {
  [ROLES.PATIENT]: 'PATIENT',
  [ROLES.RECEPTIONIST]: 'DESK',
  [ROLES.DOCTOR]: 'DOCTOR',
  [ROLES.EXEC_ADMIN]: 'ADMIN',
  [ROLES.SUPER_ADMIN]: 'ADMIN',
};

/**
 * Cancel a token. Money is never touched: a paid token stays paid, and the
 * patient is told before they confirm that cancelling does not refund.
 *
 * A patient may cancel their own booking while it is waiting, with or without
 * saying why. Clinic staff must give a reason — the patient and the doctor
 * both see it — and may also cancel a skipped token (a no-show who is not
 * coming back). Any cancellation the doctor did not make themselves is
 * flagged to that doctor until they acknowledge it.
 */
export const cancelToken = async ({ tokenId, actor, reason }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Token not found');
  assertTokenScope(actor, token);

  const byRole = CANCEL_ROLE[actor.role] ?? 'ADMIN';
  const isPatient = byRole === 'PATIENT';
  const cancellable = isPatient ? [TOKEN_STATUS.WAITING] : [TOKEN_STATUS.WAITING, TOKEN_STATUS.SKIPPED];
  if (!cancellable.includes(token.status)) {
    throw conflict(
      token.status === TOKEN_STATUS.IN_CHAMBER
        ? 'This patient is already with the doctor and cannot be cancelled'
        : token.status === TOKEN_STATUS.CANCELLED
          ? 'This token is already cancelled'
          : isPatient ? 'Only a waiting token can be cancelled' : 'Only a waiting or skipped token can be cancelled',
    );
  }
  const why = String(reason || '').trim();
  if (!isPatient && why.length < 5) {
    throw validationError([{ path: 'reason', message: 'Give a reason for cancelling — the patient and the doctor will see it' }]);
  }

  const updated = await transition(token, TOKEN_STATUS.CANCELLED, {
    actor,
    reason: why || 'Cancelled by patient',
  });
  // The doctor is flagged unless they cancelled it themselves.
  const flagDoctor = byRole !== 'DOCTOR';
  await OPDToken.updateOne(
    { _id: token._id },
    { $set: { cancelledByRole: byRole, 'doctorAlert.pending': flagDoctor, 'doctorAlert.acknowledgedAt': null } },
  );
  // Cancelling a doctor-booked follow-up is the patient saying they will not
  // come, so the doctor's follow-up list must read "declined", not "pending".
  if ([FOLLOWUP_STATUS.PENDING, FOLLOWUP_STATUS.CONFIRMED].includes(token.followUp?.status)) {
    await OPDToken.updateOne(
      { _id: token._id },
      { $set: { 'followUp.status': FOLLOWUP_STATUS.DECLINED, 'followUp.respondedAt': new Date() } },
    );
  }

  const by = await User.findById(actor.id).select('name').lean();
  if (flagDoctor) emitTokenCancelled({ token: { ...updated, cancelReason: why || 'Cancelled by patient' }, byRole, byName: by?.name });
  writeAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.TOKEN_CANCELLED,
    entityType: 'OPDToken',
    entityId: token._id,
    hospitalId: token.hospitalId,
    // Whether money was kept is the question an audit of a cancellation asks.
    after: { reason: why || 'Cancelled by patient', byRole, wasPaid: Boolean(token.isPaid), refunded: false },
  });

  await emitQueueSnapshot(token.doctorId, token.date);
  return { ...updated, cancelledByRole: byRole };
};

/** The doctor has seen a cancellation flagged to them. */
export const acknowledgeCancellation = async ({ tokenId, actor }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Token not found');
  if (actor.role === ROLES.DOCTOR && String(token.doctorId) !== String(actor.doctorId)) {
    throw notFound('Token not found');
  }
  assertTokenScope(actor, token);
  if (token.status !== TOKEN_STATUS.CANCELLED) throw conflict('This token is not cancelled');
  await OPDToken.updateOne(
    { _id: token._id },
    { $set: { 'doctorAlert.pending': false, 'doctorAlert.acknowledgedAt': new Date() } },
  );
  await emitQueueSnapshot(token.doctorId, token.date);
  return { tokenId: String(token._id), acknowledged: true };
};
