/**
 * Doctors' identity and registration papers: Aadhaar, PAN and the medical
 * registration certificate. Stored as private objects — they never get a
 * public URL — and read back only through routes that check who is asking.
 */
import { Doctor, Hospital, OnboardingSubmission } from '../models/index.js';
import { processDocumentPhoto, putPrivateObject, readPrivateObject, assertUploadable } from './storage.js';
import { assertSubmissionScope } from '../middleware/rbac.js';
import { forbidden, notFound, validationError } from '../lib/errors.js';
import { DOCTOR_DOC_TYPES, ROLES } from '../config/constants.js';

export const assertDocType = (type) => {
  if (!DOCTOR_DOC_TYPES.includes(type)) {
    throw validationError([{ path: 'type', message: `Document type must be one of ${DOCTOR_DOC_TYPES.join(', ')}` }]);
  }
  return type;
};

/** Store one document photo privately; returns its key, never a URL. */
export const storeDocument = async (file, prefix) => {
  assertUploadable(file);
  const processed = await processDocumentPhoto(file.buffer);
  const { objectPath } = await putPrivateObject({ ...processed, prefix });
  return objectPath;
};

/** Bytes and type of a stored document, or a 404 when it is gone. */
export const readDocument = async (objectPath) => {
  const buf = await readPrivateObject(objectPath);
  if (!buf) throw notFound('Document not found');
  const ext = objectPath.split('.').pop().toLowerCase();
  return { buf, contentType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
};

/**
 * May this person see an onboarding document? The agent who uploaded it
 * (their own prefix), a Super Admin, or an admin who may see a submission
 * that names it.
 */
export const assertOnboardingDocAccess = async (actor, objectPath) => {
  if (!/^kyc\//.test(String(objectPath))) throw notFound('Document not found');
  if (actor.role === ROLES.SUPER_ADMIN) return;
  if (objectPath.startsWith(`kyc/${actor.id}/`)) return;
  const sub = await OnboardingSubmission.findOne({ 'payload.doctors.documents.objectPath': objectPath }).lean();
  if (!sub) throw notFound('Document not found');
  assertSubmissionScope(actor, sub);
};

/**
 * Who may see a doctor's papers: the doctor, their district admin, and the
 * Super Admin. Deliberately not the front desk — these are identity
 * documents, not something the counter needs.
 */
export const loadDoctorForDocs = async (actor, doctorId, { write = false } = {}) => {
  const doctor = await Doctor.findById(doctorId).select('+kycDocuments name hospitalId').catch(() => null);
  if (!doctor) throw notFound('Doctor not found');
  if (actor.role === ROLES.SUPER_ADMIN) return doctor;
  if (actor.role === ROLES.DOCTOR && String(actor.doctorId) === String(doctor._id)) return doctor;
  if (!write && actor.role === ROLES.EXEC_ADMIN) {
    const h = await Hospital.findById(doctor.hospitalId).select('districtId').lean();
    if (h && String(h.districtId) === String(actor.districtId)) return doctor;
  }
  throw forbidden('You cannot view this doctor’s documents');
};
