import { Prescription, OPDToken, Doctor, Hospital } from '../../models/index.js';
import { forbidden, notFound, conflict } from '../../lib/errors.js';
import { assertHospitalScope } from '../../middleware/rbac.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { AUDIT_ACTIONS, ROLES, TOKEN_STATUS } from '../../config/constants.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** The presenting complaint plus declared conditions, as one line. */
export const symptomsOf = (token) => [
  token.patientSnapshot?.complaint,
  ...(token.patientSnapshot?.conditions ?? []).map((c) => `k/c/o ${c}`),
].filter(Boolean).join('; ');

/**
 * Write a prescription for one token.
 *
 * Only the doctor the token belongs to may prescribe on it — a receptionist
 * may read the record, never write one. A token that was cancelled or is
 * awaiting reschedule was never seen, so it cannot carry a prescription.
 */
export const createPrescription = async ({ body, actor }) => {
  const token = await OPDToken.findById(body.tokenId).lean();
  if (!token) throw notFound('Token not found');
  if (actor.role === ROLES.DOCTOR && !sameId(token.doctorId, actor.doctorId)) {
    throw forbidden('You can only prescribe for your own patients');
  }
  if (![TOKEN_STATUS.IN_CHAMBER, TOKEN_STATUS.COMPLETED, TOKEN_STATUS.WAITING].includes(token.status)) {
    throw conflict('This token was not seen, so it cannot carry a prescription');
  }

  const [doctor, hospital] = await Promise.all([
    Doctor.findById(token.doctorId).select('name specialty chamberNumber qualifications hospitalId').lean(),
    Hospital.findById(token.hospitalId).select('_id districtId name').lean(),
  ]);
  assertHospitalScope(actor, hospital);

  const rx = await Prescription.create({
    hospitalId: token.hospitalId,
    doctorId: token.doctorId,
    patientId: token.patientId,
    tokenId: token._id,
    tokenNumber: token.tokenNumber,
    date: token.date,
    patientSnapshot: {
      name: token.patientSnapshot?.name,
      phone: token.patientSnapshot?.phone,
      age: token.patientSnapshot?.age,
      gender: token.patientSnapshot?.gender,
    },
    doctorSnapshot: {
      name: doctor?.name,
      specialty: doctor?.specialty,
      chamberNumber: doctor?.chamberNumber,
      qualifications: doctor?.qualifications ?? [],
    },
    symptoms: body.symptoms?.trim() || symptomsOf(token),
    diagnosis: body.diagnosis,
    medicines: body.medicines,
    advice: body.advice,
    reviewDate: body.reviewDate || null,
    totalDue: body.totalDue ?? null,
    hospitalName: hospital?.name ?? '',
    createdBy: actor.id,
  });

  writeAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRESCRIPTION_WRITTEN,
    entityType: 'Prescription',
    entityId: rx._id,
    hospitalId: hospital._id,
    districtId: hospital.districtId,
    // Counts only: the audit trail records that a prescription was written,
    // not its clinical contents.
    after: { tokenId: String(token._id), medicines: body.medicines.length },
  });

  return rx.toObject();
};

/**
 * Prescriptions within the caller's own clinic. A patient's records at other
 * clinics are not shown here: one clinic's EMR is not another's to read.
 */
export const listPrescriptions = async ({ query, actor }) => {
  const filter = {};
  if (actor.role !== ROLES.SUPER_ADMIN) filter.hospitalId = actor.hospitalId;
  if (query.patientId) filter.patientId = query.patientId;
  if (query.tokenId) filter.tokenId = query.tokenId;
  if (query.doctorId) filter.doctorId = query.doctorId;
  if (query.date) filter.date = query.date;
  if (!query.patientId && !query.tokenId && !query.date) {
    throw conflict('Name a patient, token or date');
  }
  return Prescription.find(filter).sort({ createdAt: -1 }).limit(query.limit || 50).lean();
};

export const getPrescription = async ({ id, actor }) => {
  const rx = await Prescription.findById(id).lean().catch(() => null);
  if (!rx) throw notFound('Prescription not found');
  if (actor.role !== ROLES.SUPER_ADMIN && !sameId(rx.hospitalId, actor.hospitalId)) throw notFound('Prescription not found');
  return rx;
};

/**
 * A mobile number's recent visits at the caller's clinic, newest first, each
 * with whatever was prescribed. Keyed on the number rather than the account
 * because that is what the patient gives at the counter — and a family that
 * shares one phone should all come up together.
 *
 * Deliberately short (three visits by default): the full history is the
 * footfall register's job.
 */
export const lookupByPhone = async ({ query, actor }) => {
  const filter = { 'patientSnapshot.phone': query.phone, status: { $nin: [TOKEN_STATUS.CANCELLED] } };
  if (actor.role !== ROLES.SUPER_ADMIN) filter.hospitalId = actor.hospitalId;
  const limit = query.visits || 3;
  const [tokens, total] = await Promise.all([
    OPDToken.find(filter)
      .select('tokenNumber date status visitType patientSnapshot doctorId createdAt completedAt outcome')
      .sort({ date: -1, createdAt: -1 }).limit(limit).lean(),
    OPDToken.countDocuments(filter),
  ]);
  const [rx, doctors] = await Promise.all([
    Prescription.find({ tokenId: { $in: tokens.map((t) => t._id) } }).sort({ createdAt: -1 }).lean(),
    Doctor.find({ _id: { $in: [...new Set(tokens.map((t) => String(t.doctorId)))] } }).select('name specialty').lean(),
  ]);
  const docById = new Map(doctors.map((d) => [String(d._id), d]));
  return {
    phone: query.phone,
    totalVisits: total,
    visits: tokens.map((t) => ({
      tokenId: String(t._id),
      tokenNumber: t.tokenNumber,
      date: t.date,
      status: t.status,
      visitType: t.visitType || 'fresh',
      outcome: t.outcome ?? null,
      patientName: t.patientSnapshot?.name || '',
      age: t.patientSnapshot?.age ?? null,
      gender: t.patientSnapshot?.gender ?? null,
      symptoms: symptomsOf(t),
      doctorName: docById.get(String(t.doctorId))?.name || '',
      prescriptions: rx.filter((r) => sameId(r.tokenId, t._id)),
    })),
  };
};
