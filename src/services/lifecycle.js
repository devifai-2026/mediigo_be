import mongoose from 'mongoose';
import {
  Hospital, Doctor, User, OPDToken, QRStandee, OnboardingSubmission,
} from '../models/index.js';
import { conflict, notFound, validationError, forbidden } from '../lib/errors.js';
import { assertHospitalScope, assertSubmissionScope } from '../middleware/rbac.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { clinicDate } from '../lib/dates.js';
import { hashPassword } from '../modules/auth/service.js';
import { randomToken } from '../lib/crypto.js';
import { emitHospitalState, emitHospitalDeboarded, emitSubmissionStatus, emitDoctorSession } from '../realtime/emitters.js';
import {
  NETWORK_STATE, SUBMISSION_STATUS, TOKEN_STATUS, IN_FLIGHT_STATUSES,
  STANDEE_STATUS, ROLES, RESPONSE_CODES, AUDIT_ACTIONS,
} from '../config/constants.js';

// Every legal transition in one frozen map. No controller sets networkState
// directly — they all go through assertTransition.
const HOSPITAL_TRANSITIONS = Object.freeze({
  [NETWORK_STATE.PENDING_APPROVAL]: [NETWORK_STATE.ACTIVE, NETWORK_STATE.DEBOARDED],
  [NETWORK_STATE.ACTIVE]: [NETWORK_STATE.SUSPENDED, NETWORK_STATE.DEBOARDED],
  [NETWORK_STATE.SUSPENDED]: [NETWORK_STATE.ACTIVE, NETWORK_STATE.DEBOARDED],
  [NETWORK_STATE.DEBOARDED]: [],
});

export const assertTransition = (from, to) => {
  if (!HOSPITAL_TRANSITIONS[from]?.includes(to)) {
    throw conflict(
      `A ${from.toLowerCase().replace('_', ' ')} clinic cannot become ${to.toLowerCase()}`,
      RESPONSE_CODES.ILLEGAL_TRANSITION,
      { from, to, allowed: HOSPITAL_TRANSITIONS[from] ?? [] },
    );
  }
};

const requireReason = (reason) => {
  // A one-word reason is useless three months later in a dispute.
  if (!reason || String(reason).trim().length < 10) {
    throw validationError([{ path: 'reason', message: 'Give a reason of at least 10 characters — this is a permanent audit record' }]);
  }
  return String(reason).trim();
};

/**
 * Approve an agent submission: creates the Hospital (or Doctor) as ACTIVE.
 *
 * `password` lets the approver choose the new account's sign-in password. When
 * omitted a random one is generated and returned as `tempPassword` — which is
 * secure, but is shown exactly once, so an approver who does not write it down
 * leaves an account nobody can log into. Passing a password avoids that.
 */
export const approveSubmission = async ({ submissionId, actor, ip, userAgent, password }) => {
  const submission = await OnboardingSubmission.findById(submissionId);
  if (!submission) throw notFound('Submission not found');
  assertSubmissionScope(actor, submission);

  if (![SUBMISSION_STATUS.SUBMITTED, SUBMISSION_STATUS.UNDER_REVIEW].includes(submission.status)) {
    throw conflict(`This submission is already ${submission.status.toLowerCase().replace('_', ' ')}`);
  }
  // A hospital with no coordinates is invisible to nearby search, so activating
  // one is pointless. Refuse rather than create a ghost record.
  if (submission.kind === 'HOSPITAL' && (!submission.geocodeResult?.lat || !submission.geocodeResult?.lng)) {
    throw conflict('This submission has no verified location — geocode it before approving');
  }

  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const p = submission.payload;

      if (submission.kind === 'HOSPITAL') {
        const existing = await Hospital.findOne({ code: p.code }).session(session);
        const hospitalDoc = {
          code: p.code,
          name: p.name,
          type: p.type || 'CLINIC',
          licenseNumber: p.licenseNumber,
          districtId: submission.districtId,
          address: { ...p.address, formatted: submission.geocodeResult.formatted },
          location: { type: 'Point', coordinates: [submission.geocodeResult.lng, submission.geocodeResult.lat] },
          geocode: { source: 'GOOGLE', accuracy: submission.geocodeResult.accuracy, geocodedAt: new Date() },
          subscriptionPlan: p.subscriptionPlan || 'FREE',
          networkState: NETWORK_STATE.ACTIVE,
          onboardedBy: submission.agentId,
          approvedBy: actor.id,
          submissionId: submission._id,
          contactPhone: p.primaryContact?.phone,
        };

        let hospital;
        if (existing) {
          assertTransition(existing.networkState, NETWORK_STATE.ACTIVE);
          await Hospital.updateOne(
            { _id: existing._id },
            {
              $set: { ...hospitalDoc },
              $push: { stateHistory: { from: existing.networkState, to: NETWORK_STATE.ACTIVE, byUserId: actor.id, at: new Date() } },
            },
            { session },
          );
          hospital = await Hospital.findById(existing._id).session(session);
        } else {
          [hospital] = await Hospital.create(
            [{ ...hospitalDoc, stateHistory: [{ from: null, to: NETWORK_STATE.ACTIVE, byUserId: actor.id, at: new Date() }] }],
            { session },
          );
        }

        // The front desk needs an account from day one.
        if (p.primaryContact?.phone) {
          const already = await User.findOne({ phone: p.primaryContact.phone }).session(session);
          if (!already) {
            const tempPassword = password || randomToken(6);
            await User.create(
              [{
                phone: p.primaryContact.phone,
                name: p.primaryContact.name || `${p.name} Reception`,
                role: ROLES.RECEPTIONIST,
                passwordHash: await hashPassword(tempPassword),
                hospitalId: hospital._id,
                createdBy: actor.id,
              }],
              { session },
            );
            created = { tempPassword };
          }
        }

        submission.createdHospitalId = hospital._id;
        created = { ...(created || {}), hospital: hospital.toObject() };
      }

      if (submission.kind === 'DOCTOR') {
        const hospital = await Hospital.findById(p.hospitalId).session(session);
        if (!hospital) throw notFound('Parent hospital not found');
        if (hospital.networkState !== NETWORK_STATE.ACTIVE) {
          throw conflict('The parent clinic must be active before adding a doctor');
        }
        const tempPassword = password || randomToken(6);
        const [user] = await User.create(
          [{
            phone: p.phone, name: p.name, role: ROLES.DOCTOR,
            passwordHash: await hashPassword(tempPassword),
            hospitalId: hospital._id, createdBy: actor.id,
          }],
          { session },
        );
        const [doctor] = await Doctor.create(
          [{
            userId: user._id, hospitalId: hospital._id, name: p.name, specialty: p.specialty,
            qualifications: p.qualifications || [], councilRegNo: p.councilRegNo,
            chamberNumber: p.chamberNumber, fees: p.fees,
          }],
          { session },
        );
        await User.updateOne({ _id: user._id }, { $set: { doctorId: doctor._id } }, { session });
        submission.createdDoctorId = doctor._id;
        created = { doctor: doctor.toObject(), tempPassword };
      }

      submission.status = SUBMISSION_STATUS.APPROVED;
      submission.reviewedBy = actor.id;
      submission.reviewedAt = new Date();
      await submission.save({ session });
    });
  } finally {
    await session.endSession();
  }

  const hospital = created?.hospital;
  if (hospital) emitHospitalState({ hospital, from: NETWORK_STATE.PENDING_APPROVAL, to: NETWORK_STATE.ACTIVE });
  emitSubmissionStatus({ submission, from: SUBMISSION_STATUS.SUBMITTED, to: SUBMISSION_STATUS.APPROVED });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOSPITAL_APPROVED,
    entityType: submission.kind === 'HOSPITAL' ? 'Hospital' : 'Doctor',
    entityId: submission.createdHospitalId || submission.createdDoctorId,
    districtId: submission.districtId, hospitalId: submission.createdHospitalId,
    ip, userAgent, after: { submissionId: String(submission._id) },
  });

  return created;
};

export const rejectSubmission = async ({ submissionId, reason, actor, ip, userAgent }) => {
  const submission = await OnboardingSubmission.findById(submissionId);
  if (!submission) throw notFound('Submission not found');
  assertSubmissionScope(actor, submission);
  const why = requireReason(reason);

  const from = submission.status;
  submission.status = SUBMISSION_STATUS.REJECTED;
  submission.rejectionReason = why;
  submission.reviewedBy = actor.id;
  submission.reviewedAt = new Date();
  await submission.save();

  emitSubmissionStatus({ submission, from, to: SUBMISSION_STATUS.REJECTED });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOSPITAL_REJECTED,
    entityType: 'OnboardingSubmission', entityId: submission._id,
    districtId: submission.districtId, reason: why, ip, userAgent,
  });
  return submission.toObject();
};

/**
 * SUSPEND — reversible. Stops new bookings but deliberately leaves today's queue
 * alone: those patients are physically in the waiting room, and voiding their
 * paid tokens would create refund chaos. The queue drains naturally.
 */
export const suspendHospital = async ({ hospitalId, reason, actor, ip, userAgent }) => {
  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) throw notFound('Clinic not found');
  assertHospitalScope(actor, hospital);
  const why = requireReason(reason);
  assertTransition(hospital.networkState, NETWORK_STATE.SUSPENDED);

  const from = hospital.networkState;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Hospital.updateOne(
        { _id: hospital._id },
        {
          $set: { networkState: NETWORK_STATE.SUSPENDED, suspendedAt: new Date(), suspendReason: why },
          $push: { stateHistory: { from, to: NETWORK_STATE.SUSPENDED, reason: why, byUserId: actor.id, at: new Date() } },
        },
        { session },
      );
      // Close booking, but leave isOnBreak and in-flight tokens untouched.
      await Doctor.updateMany({ hospitalId: hospital._id }, { $set: { 'session.isBookingOpen': false } }, { session });
    });
  } finally {
    await session.endSession();
  }

  const updated = await Hospital.findById(hospital._id).lean();
  emitHospitalState({ hospital: updated, from, to: NETWORK_STATE.SUSPENDED, reason: why });
  const docs = await Doctor.find({ hospitalId: hospital._id }).lean();
  docs.forEach((d) => emitDoctorSession(d));
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOSPITAL_SUSPENDED,
    entityType: 'Hospital', entityId: hospital._id, hospitalId: hospital._id,
    districtId: hospital.districtId, reason: why, ip, userAgent,
    before: { networkState: from }, after: { networkState: NETWORK_STATE.SUSPENDED },
  });
  return updated;
};

/**
 * Reactivate. Deliberately does NOT reopen doctor sessions — auto-reopening for
 * a doctor who is not in the building would start selling tokens for an empty
 * chamber.
 */
export const reactivateHospital = async ({ hospitalId, actor, ip, userAgent }) => {
  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) throw notFound('Clinic not found');
  assertHospitalScope(actor, hospital);
  assertTransition(hospital.networkState, NETWORK_STATE.ACTIVE);

  const from = hospital.networkState;
  await Hospital.updateOne(
    { _id: hospital._id },
    {
      $set: { networkState: NETWORK_STATE.ACTIVE, suspendedAt: null, suspendReason: null },
      $push: { stateHistory: { from, to: NETWORK_STATE.ACTIVE, byUserId: actor.id, at: new Date() } },
    },
  );

  const updated = await Hospital.findById(hospital._id).lean();
  emitHospitalState({ hospital: updated, from, to: NETWORK_STATE.ACTIVE });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOSPITAL_REACTIVATED,
    entityType: 'Hospital', entityId: hospital._id, hospitalId: hospital._id,
    districtId: hospital.districtId, ip, userAgent,
    before: { networkState: from }, after: { networkState: NETWORK_STATE.ACTIVE },
  });
  return updated;
};

/**
 * DEBOARD — terminal and Super Admin only.
 *
 * Refuses while any patient is still in today's queue unless force is set. On
 * force: their tokens are skipped, standees are reclaimed for reuse, and staff
 * accounts are deactivated (never deleted — audit integrity and any future
 * re-onboarding depend on them). Paid tokens are listed for MANUAL refund;
 * cash taken at a physical counter is reversed by a human, not a cron job.
 */
export const deboardHospital = async ({ hospitalId, reason, force = false, actor, ip, userAgent }) => {
  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) throw notFound('Clinic not found');
  assertHospitalScope(actor, hospital);
  const why = requireReason(reason);

  // An Exec Admin may only REQUEST. Terminal destruction of a revenue
  // relationship needs two roles.
  if (actor.role !== ROLES.SUPER_ADMIN) {
    writeAuditLog({
      actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEBOARD_REQUESTED,
      entityType: 'Hospital', entityId: hospital._id, hospitalId: hospital._id,
      districtId: hospital.districtId, reason: why, ip, userAgent,
    });
    return { requested: true, requiresSuperAdmin: true, hospitalId: String(hospital._id), reason: why };
  }

  assertTransition(hospital.networkState, NETWORK_STATE.DEBOARDED);

  const date = clinicDate(hospital.timezone);
  const inFlight = await OPDToken.find({
    hospitalId: hospital._id, date, status: { $in: IN_FLIGHT_STATUSES },
  }).select('_id tokenNumber isPaid patientId').lean();

  if (inFlight.length > 0 && !force) {
    throw conflict(
      `${inFlight.length} patient${inFlight.length === 1 ? ' is' : 's are'} still in today's queue at this clinic`,
      RESPONSE_CODES.IN_FLIGHT_TOKENS,
      { inFlightTokens: inFlight.length, tokenNumbers: inFlight.map((t) => t.tokenNumber) },
    );
  }

  const from = hospital.networkState;
  const doctors = await Doctor.find({ hospitalId: hospital._id }).select('_id').lean();
  let impact = { tokensSkipped: 0, standeesReclaimed: 0, staffDeactivated: 0 };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Hospital.updateOne(
        { _id: hospital._id },
        {
          $set: { networkState: NETWORK_STATE.DEBOARDED, deboardedAt: new Date(), deboardReason: why },
          $push: { stateHistory: { from, to: NETWORK_STATE.DEBOARDED, reason: why, byUserId: actor.id, at: new Date() } },
        },
        { session },
      );

      await Doctor.updateMany(
        { hospitalId: hospital._id },
        {
          $set: {
            isActive: false, deboardedAt: new Date(),
            'session.isBookingOpen': false, 'session.isOnBreak': false,
            'session.breakReason': null, 'session.breakUntil': null,
          },
        },
        { session },
      );

      const skipped = await OPDToken.updateMany(
        { hospitalId: hospital._id, date, status: { $in: IN_FLIGHT_STATUSES } },
        {
          $set: { status: TOKEN_STATUS.SKIPPED, skippedAt: new Date(), skipReason: 'HOSPITAL_DEBOARDED' },
          $push: { statusHistory: { from: null, to: TOKEN_STATUS.SKIPPED, at: new Date(), byUserId: actor.id, reason: 'HOSPITAL_DEBOARDED' } },
        },
        { session },
      );

      // Nulling hospitalId is what makes the physical standee reusable;
      // lastHospitalId keeps the audit trail intact.
      const reclaimed = await QRStandee.updateMany(
        { hospitalId: hospital._id, status: STANDEE_STATUS.DEPLOYED },
        {
          $set: {
            status: STANDEE_STATUS.RECLAIMED, reclaimedAt: new Date(),
            reclaimReason: 'HOSPITAL_DEBOARDED', lastHospitalId: hospital._id,
            hospitalId: null, doctorId: null,
          },
        },
        { session },
      );

      const staff = await User.updateMany(
        { hospitalId: hospital._id, role: { $in: [ROLES.DOCTOR, ROLES.RECEPTIONIST] } },
        { $set: { isActive: false } },
        { session },
      );

      impact = {
        tokensSkipped: skipped.modifiedCount,
        standeesReclaimed: reclaimed.modifiedCount,
        staffDeactivated: staff.modifiedCount,
      };
    });
  } finally {
    await session.endSession();
  }

  const updated = await Hospital.findById(hospital._id).lean();
  emitHospitalDeboarded({ hospital: updated, reason: why, impact, doctorIds: doctors.map((d) => String(d._id)) });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.HOSPITAL_DEBOARDED,
    entityType: 'Hospital', entityId: hospital._id, hospitalId: hospital._id,
    districtId: hospital.districtId, reason: why, ip, userAgent,
    before: { networkState: from }, after: { networkState: NETWORK_STATE.DEBOARDED, impact },
  });

  const pendingRefunds = inFlight.filter((t) => t.isPaid);
  return { hospital: updated, impact, pendingRefunds: pendingRefunds.length, forced: force };
};

export const listPendingRefunds = async ({ hospitalId, actor }) => {
  const hospital = await Hospital.findById(hospitalId).lean();
  if (!hospital) throw notFound('Clinic not found');
  assertHospitalScope(actor, hospital);
  return OPDToken.find({
    hospitalId: hospital._id, status: TOKEN_STATUS.SKIPPED,
    skipReason: 'HOSPITAL_DEBOARDED', isPaid: true,
  })
    .populate('transactionId')
    .lean();
};

/** Doctor-level deboard: narrower, the hospital stays ACTIVE. */
export const deboardDoctor = async ({ doctorId, reason, actor, ip, userAgent }) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  const hospital = await Hospital.findById(doctor.hospitalId).lean();
  assertHospitalScope(actor, hospital);
  const why = requireReason(reason);
  const date = clinicDate(hospital.timezone);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Doctor.updateOne(
        { _id: doctor._id },
        { $set: { isActive: false, deboardedAt: new Date(), 'session.isBookingOpen': false, 'session.isOnBreak': false } },
        { session },
      );
      await OPDToken.updateMany(
        { doctorId: doctor._id, date, status: { $in: IN_FLIGHT_STATUSES } },
        {
          $set: { status: TOKEN_STATUS.SKIPPED, skippedAt: new Date(), skipReason: 'DOCTOR_DEBOARDED' },
          $push: { statusHistory: { from: null, to: TOKEN_STATUS.SKIPPED, at: new Date(), byUserId: actor.id } },
        },
        { session },
      );
      await User.updateOne({ _id: doctor.userId }, { $set: { isActive: false } }, { session });
    });
  } finally {
    await session.endSession();
  }

  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DOCTOR_DEBOARDED,
    entityType: 'Doctor', entityId: doctor._id, hospitalId: hospital._id,
    districtId: hospital.districtId, reason: why, ip, userAgent,
  });
  return Doctor.findById(doctor._id).lean();
};
