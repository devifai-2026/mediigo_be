import { Prescription, OPDToken, Doctor, Hospital } from '../../models/index.js';
import { forbidden, notFound, conflict } from '../../lib/errors.js';
import { assertHospitalScope } from '../../middleware/rbac.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { AUDIT_ACTIONS, ROLES, TOKEN_STATUS } from '../../config/constants.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

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
    Hospital.findById(token.hospitalId).select('_id districtId').lean(),
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
    diagnosis: body.diagnosis,
    medicines: body.medicines,
    advice: body.advice,
    reviewDate: body.reviewDate || null,
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
