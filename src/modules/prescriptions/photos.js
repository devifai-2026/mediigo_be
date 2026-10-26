import { OPDToken, PatientPhoto, PATIENT_PHOTO_KIND, User } from '../../models/index.js';
import { assertUploadable, processDocumentPhoto, putPrivateObject, readPrivateObject, deletePrivateObject } from '../../services/storage.js';
import { forbidden, notFound, conflict, validationError } from '../../lib/errors.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { AUDIT_ACTIONS, ROLES, TOKEN_STATUS } from '../../config/constants.js';
import { recordScope, photoRow } from './service.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// A visit's record is a handful of pages, not an album.
const MAX_PER_VISIT = 20;

/**
 * Attach a photo to a visit: a paper prescription, or anything about the
 * patient's health. The doctor adds to their own patients' visits; the front
 * desk to any visit at the clinic, since it is often the desk that takes the
 * patient's old prescription and scans it in.
 */
export const addPhoto = async ({ file, body, actor }) => {
  assertUploadable(file);
  const kind = body.kind;
  if (!Object.values(PATIENT_PHOTO_KIND).includes(kind)) {
    throw validationError([{ path: 'kind', message: 'Choose prescription or health photo' }]);
  }
  // The front desk scans paper prescriptions in; photos of the patient's
  // body are clinical and stay with the doctor.
  if (actor.role === ROLES.RECEPTIONIST && kind !== PATIENT_PHOTO_KIND.PRESCRIPTION) {
    throw forbidden('The front desk can upload prescription photos only');
  }
  const caption = String(body.caption || '').trim().slice(0, 200);

  const token = await OPDToken.findById(body.tokenId).catch(() => null);
  if (!token) throw notFound('Visit not found');
  if (actor.role !== ROLES.SUPER_ADMIN && !sameId(token.hospitalId, actor.hospitalId)) throw notFound('Visit not found');
  if (actor.role === ROLES.DOCTOR && !sameId(token.doctorId, actor.doctorId)) {
    throw forbidden('You can only add photos to your own patients’ visits');
  }
  if (token.status === TOKEN_STATUS.CANCELLED) throw conflict('This visit was cancelled');
  if (await PatientPhoto.countDocuments({ tokenId: token._id }) >= MAX_PER_VISIT) {
    throw conflict(`A visit can hold up to ${MAX_PER_VISIT} photos`);
  }

  const processed = await processDocumentPhoto(file.buffer);
  const stored = await putPrivateObject({ ...processed, prefix: `records/${token.hospitalId}/${token._id}` });
  const uploader = await User.findById(actor.id).select('name').lean();

  const photo = await PatientPhoto.create({
    hospitalId: token.hospitalId,
    doctorId: token.doctorId,
    tokenId: token._id,
    patientId: token.patientId ?? null,
    date: token.date,
    patientSnapshot: { name: token.patientSnapshot?.name, phone: token.patientSnapshot?.phone },
    kind,
    caption,
    objectPath: stored.objectPath,
    contentType: processed.contentType,
    bytes: stored.bytes,
    uploadedBy: actor.id,
    uploadedByRole: actor.role,
    uploadedByName: uploader?.name || '',
  });

  writeAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PATIENT_PHOTO_ADDED,
    entityType: 'PatientPhoto',
    entityId: photo._id,
    hospitalId: token.hospitalId,
    // That a photo was added, never what it shows.
    after: { tokenId: String(token._id), kind },
  });
  return photoRow(photo);
};

const findInScope = async (id, actor) => {
  const photo = await PatientPhoto.findById(id).lean().catch(() => null);
  const ok = photo && Object.entries(recordScope(actor)).every(([k, v]) => sameId(photo[k], v));
  if (!ok) throw notFound('Photo not found');
  return photo;
};

/** The image itself, for someone allowed to read this visit's record. */
export const fileOf = async ({ id, actor }) => {
  const photo = await findInScope(id, actor);
  const buffer = await readPrivateObject(photo.objectPath);
  if (!buffer) throw notFound('This photo is no longer available');
  return { buffer, contentType: photo.contentType || 'image/jpeg' };
};

/**
 * Take a photo off the record — a blurred shot, or the wrong patient. Whoever
 * added it may remove it, and so may the visit's doctor.
 */
export const removePhoto = async ({ id, actor }) => {
  const photo = await findInScope(id, actor);
  const mayRemove = actor.role === ROLES.SUPER_ADMIN
    || sameId(photo.uploadedBy, actor.id)
    || (actor.role === ROLES.DOCTOR && sameId(photo.doctorId, actor.doctorId));
  if (!mayRemove) throw forbidden('Only whoever added this photo, or the visit’s doctor, can remove it');
  await PatientPhoto.deleteOne({ _id: photo._id });
  await deletePrivateObject(photo.objectPath);
  writeAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PATIENT_PHOTO_REMOVED,
    entityType: 'PatientPhoto',
    entityId: photo._id,
    hospitalId: photo.hospitalId,
    before: { tokenId: String(photo.tokenId), kind: photo.kind },
  });
  return { removed: true };
};
