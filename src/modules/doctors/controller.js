import * as service from './service.js';
import { Doctor, Hospital } from '../../models/index.js';
import { notFound } from '../../lib/errors.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { assertDoctorScope } from '../../middleware/rbac.js';
import { doctorAvailability } from '../../services/availability.js';
import { markDoctorOff, clearDoctorOff } from '../../services/absence.js';

export const nearby = async (req, res) => {
  const data = await service.nearby(req.query);
  res.json({ ok: true, ...data });
};

export const getById = async (req, res) => {
  const data = await service.getById(req.params.id);
  res.json({ ok: true, data });
};

export const list = async (req, res) => {
  const data = await service.list(req.user);
  res.json({ ok: true, data });
};

export const updateFees = async (req, res) => {
  const data = await service.updateFees({ doctorId: req.params.id, fees: req.body, actor: req.user });
  res.json({ ok: true, data });
};

export const updateProfile = async (req, res) => {
  const data = await service.updateProfile({ doctorId: req.params.id, patch: req.body, actor: req.user });
  res.json({ ok: true, data });
};

// ---- Scheduling -----------------------------------------------------------

export const availability = async (req, res) => {
  const doctor = await Doctor.findById(req.params.id).select('name schedule scheduleOverrides hospitalId').lean();
  if (!doctor) throw notFound('Doctor not found');
  const hospital = await Hospital.findById(doctor.hospitalId).select('timezone name').lean();
  const days = await doctorAvailability({ doctor: { ...doctor, _id: doctor._id }, timezone: hospital?.timezone });
  res.json({ ok: true, data: { doctorId: String(doctor._id), doctorName: doctor.name, clinicName: hospital?.name ?? '', days } });
};

export const updateSchedule = async (req, res) => {
  const doctor = await Doctor.findById(req.params.id);
  if (!doctor) throw notFound('Doctor not found');
  assertDoctorScope(req.user, doctor);
  doctor.schedule = req.body.schedule;
  await doctor.save();
  writeAuditLog({
    actorId: req.user.id, actorRole: req.user.role, action: 'DOCTOR_SCHEDULE_UPDATED',
    entityType: 'Doctor', entityId: doctor._id, after: { shifts: doctor.schedule.length },
  });
  res.json({ ok: true, data: { schedule: doctor.schedule } });
};

export const markOff = async (req, res) => {
  const doctor = await Doctor.findById(req.params.id).select('hospitalId userId');
  if (!doctor) throw notFound('Doctor not found');
  assertDoctorScope(req.user, doctor);
  const data = await markDoctorOff({
    doctorId: req.params.id, date: req.body.date, shift: req.body.shift ?? null,
    reason: req.body.reason ?? '', actor: req.user,
  });
  res.json({ ok: true, data });
};

export const clearOff = async (req, res) => {
  const doctor = await Doctor.findById(req.params.id).select('hospitalId userId');
  if (!doctor) throw notFound('Doctor not found');
  assertDoctorScope(req.user, doctor);
  const data = await clearDoctorOff({
    doctorId: req.params.id, date: req.body.date, shift: req.body.shift ?? null, actor: req.user,
  });
  res.json({ ok: true, data });
};
