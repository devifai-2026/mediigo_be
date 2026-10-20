import { Doctor, Hospital, Specialty, toSlug } from '../../models/index.js';
import { findNearbyDoctors, suggestSearch, listCities, searchPlaces } from '../../services/nearbySearch.js';
import { assertUploadable, processAvatar, putObject, deleteObject } from '../../services/storage.js';
import { notFound, forbidden, conflict } from '../../lib/errors.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { withDoctorTitle } from '../../services/lifecycle.js';
import { LOCKED_FIELDS } from './profileFields.js';
import { assertDoctorScope } from '../../middleware/rbac.js';
import { scopeFilter } from '../../middleware/rbac.js';
import { NETWORK_STATE, ROLES } from '../../config/constants.js';

export const nearby = (params) => findNearbyDoctors(params);

export const suggest = (params) => suggestSearch(params);

export const cities = () => listCities();

export const places = (params) => searchPlaces(params);

/**
 * Specialties a patient can actually filter by.
 *
 * Read from the doctors who are live on the network rather than a hardcoded
 * list: the client's constant listed eight while only four existed, so half the
 * dropdown silently returned nothing and read as a broken filter.
 */
export const specialties = async () => {
  const names = await Doctor.distinct('specialty', { isActive: true });
  return names.filter(Boolean).sort((a, b) => a.localeCompare(b));
};

export const getById = async (doctorId) => {
  const doctor = await Doctor.findById(doctorId).lean();
  if (!doctor || !doctor.isActive) throw notFound('Doctor not found');
  const hospital = await Hospital.findById(doctor.hospitalId)
    .select('name code address location networkState contactPhone photos facilities')
    .lean();
  // A patient must not be able to deep-link into a clinic that is no longer on
  // the network.
  if (hospital?.networkState !== NETWORK_STATE.ACTIVE) throw notFound('Doctor not found');
  // What the specialty is, in plain words, for the profile header. The doctor
  // stores the display name; the slug is the stable key both share.
  const spec = await Specialty.findOne({ slug: toSlug(doctor.specialty) }).select('description').lean();
  return {
    ...doctor,
    hospital,
    specialtyDescription: spec?.description || '',
    // The patient page and the desk read registration as one record.
    registration: {
      council: doctor.registrationCouncil || '',
      number: doctor.councilRegNo,
      year: doctor.registrationYear ?? null,
    },
  };
};

export const list = async (actor) => {
  const scope = scopeFilter(actor);
  const filter = { isActive: true };
  if (scope.hospitalId) filter.hospitalId = scope.hospitalId;
  if (scope.districtId) {
    const ids = await Hospital.find({ districtId: scope.districtId }).select('_id').lean();
    filter.hospitalId = { $in: ids.map((h) => h._id) };
  }
  return Doctor.find(filter).sort({ name: 1 }).lean();
};

export const updateFees = async ({ doctorId, fees, actor }) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  assertDoctorScope(actor, doctor, { selfOnly: false });
  await Doctor.updateOne({ _id: doctor._id }, { $set: { fees } });
  return Doctor.findById(doctor._id).lean();
};

/**
 * Replace a doctor's profile photo.
 *
 * The old object is deleted only AFTER the new one is safely stored, so a
 * failed upload never leaves a doctor with no photo at all. Cleanup failures
 * are swallowed by deleteObject: an orphaned object costs almost nothing, while
 * failing the request would lose an upload that already succeeded.
 */
export const setPhoto = async ({ doctorId, file, actor }) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  assertDoctorScope(actor, doctor, { selfOnly: false });

  assertUploadable(file);
  const processed = await processAvatar(file.buffer);
  const stored = await putObject({ ...processed, prefix: `doctors/${doctor._id}` });

  const previous = doctor.photo?.objectPath ?? null;
  await Doctor.updateOne(
    { _id: doctor._id },
    { $set: { photo: { url: stored.url, objectPath: stored.objectPath, updatedAt: new Date() } } },
  );
  if (previous && previous !== stored.objectPath) await deleteObject(previous);

  return Doctor.findById(doctor._id).lean();
};

export const removePhoto = async ({ doctorId, actor }) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  assertDoctorScope(actor, doctor, { selfOnly: false });

  const previous = doctor.photo?.objectPath ?? null;
  await Doctor.updateOne(
    { _id: doctor._id },
    { $set: { photo: { url: null, objectPath: null, updatedAt: new Date() } } },
  );
  if (previous) await deleteObject(previous);
  return Doctor.findById(doctor._id).lean();
};

export const updateProfile = async ({ doctorId, patch, actor }) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  assertDoctorScope(actor, doctor, { selfOnly: false });

  const next = { ...patch };

  // Credentials are fixed at onboarding. A form that echoes the current value
  // back is harmless, so only an actual change is refused.
  const lockedChanges = LOCKED_FIELDS.filter(
    (k) => k in next && String(next[k] ?? '') !== String(doctor[k] ?? ''),
  );
  if (lockedChanges.length && actor.role !== ROLES.SUPER_ADMIN) {
    throw forbidden('Registration details are locked after onboarding. Ask Mediigo support to correct them.');
  }
  LOCKED_FIELDS.forEach((k) => { if (!lockedChanges.includes(k)) delete next[k]; });
  if (next.councilRegNo) {
    const clash = await Doctor.exists({ councilRegNo: next.councilRegNo, _id: { $ne: doctor._id } });
    if (clash) throw conflict('Another doctor is already registered with this number');
  }

  // One "Dr." however it was typed, the same rule onboarding applies.
  if (next.name) next.name = withDoctorTitle(next.name);

  /**
   * Keep the denormalised `specialty` string in step with the references.
   *
   * The string is what search, the patient cards and the superadmin rollups
   * read. Letting the two drift means a doctor's card says "Pediatrics" while
   * the browse tiles file them under Dermatology — so the FIRST id wins and the
   * string follows it, unless the caller set both explicitly.
   */
  if (next.specialtyIds?.length && !next.specialty) {
    const primary = await Specialty.findById(next.specialtyIds[0]).select('name').lean();
    if (primary) next.specialty = primary.name;
  }

  await Doctor.updateOne({ _id: doctor._id }, { $set: next });

  writeAuditLog({
    actorId: actor.id, actorRole: actor.role,
    action: lockedChanges.length ? 'DOCTOR_REGISTRATION_CORRECTED' : 'DOCTOR_PROFILE_UPDATED',
    entityType: 'Doctor', entityId: doctor._id, hospitalId: doctor.hospitalId,
    before: Object.fromEntries(lockedChanges.map((k) => [k, doctor[k]])),
    after: { fields: Object.keys(next), ...Object.fromEntries(lockedChanges.map((k) => [k, next[k]])) },
  });

  return Doctor.findById(doctor._id).lean();
};

/**
 * Every doctor profile a patient can open, for the website's sitemap.xml.
 * The same visibility rule as getById: an active doctor at a live clinic.
 */
export const sitemapEntries = async () => {
  const live = await Hospital.find({ networkState: NETWORK_STATE.ACTIVE }).select('_id').lean();
  const doctors = await Doctor.find({ isActive: true, hospitalId: { $in: live.map((h) => h._id) } })
    .select('_id updatedAt')
    .sort({ updatedAt: -1 })
    .limit(45000)
    .lean();
  return doctors.map((d) => ({ id: String(d._id), updatedAt: d.updatedAt }));
};
