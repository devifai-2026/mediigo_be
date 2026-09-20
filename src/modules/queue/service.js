import mongoose from 'mongoose';
import { Doctor, Hospital, OPDToken, Transaction, User } from '../../models/index.js';
import { nextSequence, tokenCounterId } from '../../lib/counters.js';
import { clinicDate, endOfClinicDay, addMinutes, jitterDelay, sleep } from '../../lib/dates.js';
import { conflict, notFound, validationError, isDuplicateKey } from '../../lib/errors.js';
import { assertDoctorScope, assertTokenScope, assertHospitalScope } from '../../middleware/rbac.js';
import { buildQueueSnapshot } from '../../services/queueSnapshot.js';
import {
  emitQueueSnapshot, emitCallNext, emitTokenStatusChanged, emitTokenCreated,
  emitDoctorBreak, emitDoctorSession,
} from '../../realtime/emitters.js';
import {
  TOKEN_STATUS, TOKEN_SOURCE, NETWORK_STATE, RESPONSE_CODES, ROLES,
  BREAK_REASONS, BREAK_DURATIONS,
} from '../../config/constants.js';

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

const transition = async (token, to, { actor, reason } = {}) => {
  const from = token.status;
  const patch = { status: to, $push: undefined };
  const now = new Date();
  if (to === TOKEN_STATUS.IN_CHAMBER) patch.enteredChamberAt = now;
  if (to === TOKEN_STATUS.COMPLETED) patch.completedAt = now;
  if (to === TOKEN_STATUS.SKIPPED) {
    patch.skippedAt = now;
    patch.skipReason = reason || 'Not present';
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
 * Call the next waiting token.
 *
 * Completing the current patient and promoting the next is a single logical
 * step for the doctor, so it happens here rather than requiring two API calls —
 * the prototype's advanceToken() behaviour, but with explicit status history.
 */
export const callNext = async ({ doctorId, actor }) => {
  const { doctor, hospital } = await loadDoctorAndHospital(doctorId);
  assertDoctorScope(actor, doctor);
  const date = clinicDate(hospital.timezone);

  if (doctor.session?.isOnBreak) {
    throw conflict('End the break before calling the next patient', RESPONSE_CODES.CONFLICT);
  }

  // Close out whoever is in the chamber.
  const current = await OPDToken.findOne({ doctorId: doctor._id, date, status: TOKEN_STATUS.IN_CHAMBER });
  if (current) await transition(current, TOKEN_STATUS.COMPLETED, { actor });

  const next = await OPDToken.findOne({ doctorId: doctor._id, date, status: TOKEN_STATUS.WAITING })
    .sort({ tokenNumber: 1 });
  if (!next) {
    await emitQueueSnapshot(doctor._id, date);
    throw conflict('No patients are waiting', RESPONSE_CODES.CONFLICT);
  }

  const called = await transition(next, TOKEN_STATUS.IN_CHAMBER, { actor });
  await Doctor.updateOne(
    { _id: doctor._id },
    { $set: { 'session.lastCalledToken': called.tokenNumber, 'session.currentTokenId': called._id } },
  );
  await OPDToken.updateOne({ _id: called._id }, { $set: { calledAt: new Date() } });

  emitCallNext({ token: called, doctor, recall: false });
  await emitQueueSnapshot(doctor._id, date);
  return { called, completed: current ? { tokenNumber: current.tokenNumber } : null };
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

export const setTokenStatus = async ({ tokenId, to, reason, actor }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Token not found');
  assertTokenScope(actor, token);

  const legal = {
    [TOKEN_STATUS.WAITING]: [TOKEN_STATUS.IN_CHAMBER, TOKEN_STATUS.SKIPPED],
    [TOKEN_STATUS.IN_CHAMBER]: [TOKEN_STATUS.COMPLETED, TOKEN_STATUS.SKIPPED],
    [TOKEN_STATUS.SKIPPED]: [TOKEN_STATUS.WAITING],
    [TOKEN_STATUS.COMPLETED]: [],
  };
  if (!legal[token.status]?.includes(to)) {
    throw conflict(`Cannot move a token from ${token.status} to ${to}`, RESPONSE_CODES.ILLEGAL_TRANSITION);
  }

  const updated = await transition(token, to, { actor, reason });
  await emitQueueSnapshot(token.doctorId, token.date);
  return updated;
};

/** Recall a skipped patient back into the waiting list. */
export const restoreSkipped = async ({ tokenId, actor }) =>
  setTokenStatus({ tokenId, to: TOKEN_STATUS.WAITING, reason: 'Recalled from skipped drawer', actor });

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
export const bookToken = async ({ doctorId, patientId, familyMemberId, visitType = 'fresh', actor }) => {
  const { doctor, hospital } = await loadDoctorAndHospital(doctorId);
  if (hospital.networkState !== NETWORK_STATE.ACTIVE) {
    throw conflict('This clinic is not accepting bookings', RESPONSE_CODES.HOSPITAL_NOT_ACTIVE);
  }
  if (!doctor.session?.isBookingOpen) {
    throw conflict('Bookings are closed for this doctor', RESPONSE_CODES.BOOKING_CLOSED);
  }

  const date = clinicDate(hospital.timezone);
  const patient = await User.findById(patientId).lean();
  if (!patient) throw notFound('Patient not found');

  const member = familyMemberId
    ? (patient.familyMembers || []).find((m) => String(m._id) === String(familyMemberId))
    : null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let created;
      // eslint-disable-next-line no-await-in-loop
      await session.withTransaction(async () => {
        const tokenNumber = await nextSequence(tokenCounterId(doctor._id, date), session, {
          expiresAt: endOfClinicDay(date, hospital.timezone),
        });
        const [token] = await OPDToken.create(
          [{
            tokenNumber, date, doctorId: doctor._id, hospitalId: hospital._id, patientId: patient._id,
            familyMemberId: member?._id ?? null,
            patientSnapshot: {
              name: member?.name || patient.name,
              phone: patient.phone,
              gender: member?.gender || patient.gender,
            },
            visitType, source: TOKEN_SOURCE.APP, status: TOKEN_STATUS.WAITING,
            statusHistory: [{ from: null, to: TOKEN_STATUS.WAITING, at: new Date(), byUserId: actor?.id }],
            isPaid: false, bookedBy: actor?.id ?? patient._id,
          }],
          { session, ordered: true },
        );
        created = token.toObject();
      }, { writeConcern: { w: 'majority' } });

      emitTokenCreated(created);
      await emitQueueSnapshot(doctor._id, date);
      return created;
    } catch (err) {
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

export const cancelToken = async ({ tokenId, actor }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Token not found');
  assertTokenScope(actor, token);
  if (token.status !== TOKEN_STATUS.WAITING) {
    throw conflict('Only a waiting token can be cancelled');
  }
  if (token.isPaid) {
    throw conflict('This token has been paid for — the front desk must process a refund');
  }
  const updated = await transition(token, TOKEN_STATUS.SKIPPED, { actor, reason: 'Cancelled by patient' });
  await emitQueueSnapshot(token.doctorId, token.date);
  return updated;
};
