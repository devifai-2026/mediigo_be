/**
 * Marking a doctor off, and what happens to the people already booked.
 *
 * Booked patients are never silently moved or silently dropped. Their tokens go
 * to RESCHEDULE_NEEDED, which keeps the booking alive and puts the choice of a
 * new slot in front of the patient.
 */
import mongoose from 'mongoose';
import { Doctor, Hospital, OPDToken } from '../models/index.js';
import { conflict, notFound } from '../lib/errors.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { clinicDate, endOfClinicDay } from '../lib/dates.js';
import { nextSequence, tokenCounterId } from '../lib/counters.js';
import { TOKEN_STATUS, BOOKING_HORIZON_DAYS } from '../config/constants.js';
import { bookableDates, shiftsOn, resolveBookableShift, doctorAvailability } from './availability.js';
import { emitQueueSnapshot } from '../realtime/emitters.js';

/**
 * Close a date, or one sitting on it, and flag everyone booked into it.
 *
 * Returns the affected tokens so the caller can tell the clinic how many
 * patients need to be contacted.
 */
export const markDoctorOff = async ({ doctorId, date, shift = null, reason = '', actor }) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  const hospital = await Hospital.findById(doctor.hospitalId).select('timezone name').lean();
  const timezone = hospital?.timezone;

  const dates = bookableDates(timezone, BOOKING_HORIZON_DAYS);
  if (!dates.includes(date)) {
    throw conflict(`Only the next ${BOOKING_HORIZON_DAYS} days can be marked off`);
  }

  const already = (doctor.scheduleOverrides || []).some(
    (o) => o.date === date && o.kind === 'off' && (shift ? o.shift === shift : !o.shift),
  );
  if (!already) {
    doctor.scheduleOverrides.push({
      date, kind: 'off', shift: shift || null, reason, createdBy: actor?.id ?? null,
    });
    await doctor.save();
  }

  // Only the not-yet-seen. A COMPLETED consultation is history: rewriting it
  // would corrupt the day's record and the revenue it is attached to.
  const filter = {
    doctorId: doctor._id,
    date,
    status: { $in: [TOKEN_STATUS.WAITING, TOKEN_STATUS.IN_CHAMBER] },
  };
  if (shift) filter.shift = shift;

  const affected = await OPDToken.find(filter);
  for (const t of affected) {
    t.statusHistory.push({
      from: t.status, to: TOKEN_STATUS.RESCHEDULE_NEEDED, at: new Date(),
      byUserId: actor?.id, reason: reason || 'Doctor unavailable',
    });
    t.rescheduledFrom = { date: t.date, shift: t.shift, tokenNumber: t.tokenNumber };
    t.rescheduleReason = reason || `${doctor.name} is unavailable`;
    t.status = TOKEN_STATUS.RESCHEDULE_NEEDED;
    // eslint-disable-next-line no-await-in-loop
    await t.save();
  }

  writeAuditLog({
    actorId: actor?.id, actorRole: actor?.role, action: 'DOCTOR_MARKED_OFF',
    entityType: 'Doctor', entityId: doctor._id, reason,
    after: { date, shift, affectedTokens: affected.length },
  });

  await emitQueueSnapshot(doctor._id, date);

  return {
    date,
    shift,
    reason,
    affectedCount: affected.length,
    affected: affected.map((t) => ({
      tokenId: String(t._id), tokenNumber: t.tokenNumber, shift: t.shift,
      name: t.patientSnapshot?.name, phone: t.patientSnapshot?.phone,
    })),
  };
};

/** Reopen a date or sitting. Tokens already flagged stay flagged — those patients were told. */
export const clearDoctorOff = async ({ doctorId, date, shift = null, actor }) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');

  const before = doctor.scheduleOverrides.length;
  doctor.scheduleOverrides = doctor.scheduleOverrides.filter(
    (o) => !(o.date === date && o.kind === 'off' && (shift ? o.shift === shift : !o.shift)),
  );
  if (doctor.scheduleOverrides.length === before) throw conflict('No such absence to clear');
  await doctor.save();

  writeAuditLog({
    actorId: actor?.id, actorRole: actor?.role, action: 'DOCTOR_OFF_CLEARED',
    entityType: 'Doctor', entityId: doctor._id, after: { date, shift },
  });

  await emitQueueSnapshot(doctor._id, date);
  return { date, shift, cleared: true };
};

/**
 * Move a flagged token to a slot the patient chose.
 *
 * A fresh token number is allocated for the new sitting rather than carrying
 * the old one across, which would collide with that day's existing numbering.
 */
export const rescheduleToken = async ({ tokenId, date, shift, actor }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Token not found');
  if (token.status !== TOKEN_STATUS.RESCHEDULE_NEEDED) {
    throw conflict('Only a token awaiting reschedule can be moved');
  }

  const doctor = await Doctor.findById(token.doctorId);
  if (!doctor) throw notFound('Doctor not found');
  const hospital = await Hospital.findById(token.hospitalId).select('timezone').lean();

  const resolved = await resolveBookableShift({ doctor, date, shift, timezone: hospital?.timezone });
  if (!resolved.ok) throw conflict(resolved.reason);

  const from = { date: token.date, shift: token.shift, tokenNumber: token.tokenNumber };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const tokenNumber = await nextSequence(
        tokenCounterId(doctor._id, date, resolved.shift.shift),
        session,
        { expiresAt: endOfClinicDay(date, hospital?.timezone) },
      );
      token.tokenNumber = tokenNumber;
      token.date = date;
      token.shift = resolved.shift.shift;
      token.startTime = resolved.shift.startTime;
      token.endTime = resolved.shift.endTime;
      token.status = TOKEN_STATUS.WAITING;
      token.rescheduleReason = null;
      token.rescheduledFrom = from;
      token.statusHistory.push({
        from: TOKEN_STATUS.RESCHEDULE_NEEDED, to: TOKEN_STATUS.WAITING, at: new Date(),
        byUserId: actor?.id, reason: `Rescheduled from ${from.date} ${from.shift || ''}`.trim(),
      });
      await token.save({ session });
    }, { writeConcern: { w: 'majority' } });
  } finally {
    await session.endSession();
  }

  await emitQueueSnapshot(doctor._id, from.date);
  await emitQueueSnapshot(doctor._id, date);

  return token.toObject();
};

/** Open slots a stranded patient can move to — the doctor's own next 7 days. */
export const rescheduleOptions = async ({ tokenId }) => {
  const token = await OPDToken.findById(tokenId).lean();
  if (!token) throw notFound('Token not found');
  const doctor = await Doctor.findById(token.doctorId).select('name schedule scheduleOverrides hospitalId').lean();
  if (!doctor) throw notFound('Doctor not found');
  const hospital = await Hospital.findById(token.hospitalId).select('timezone name').lean();

  const days = await doctorAvailability({
    doctor: { ...doctor, _id: token.doctorId },
    timezone: hospital?.timezone,
  });

  return {
    tokenId: String(token._id),
    doctorName: doctor.name,
    clinicName: hospital?.name ?? '',
    reason: token.rescheduleReason,
    from: { date: token.date, shift: token.shift },
    days: days.filter((d) => d.isOpen),
  };
};
