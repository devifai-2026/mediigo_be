import { Doctor, Hospital, Specialty } from '../../models/index.js';
import { findNearbyDoctors, suggestSearch, listCities } from '../../services/nearbySearch.js';
import { assertUploadable, processAvatar, putObject, deleteObject } from '../../services/storage.js';
import { notFound } from '../../lib/errors.js';
import { assertDoctorScope } from '../../middleware/rbac.js';
import { scopeFilter } from '../../middleware/rbac.js';
import { NETWORK_STATE } from '../../config/constants.js';

export const nearby = (params) => findNearbyDoctors(params);

export const suggest = (params) => suggestSearch(params);

export const cities = () => listCities();

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
    .select('name code address location networkState contactPhone')
    .lean();
  // A patient must not be able to deep-link into a clinic that is no longer on
  // the network.
  if (hospital?.networkState !== NETWORK_STATE.ACTIVE) throw notFound('Doctor not found');
  return { ...doctor, hospital };
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
  return Doctor.findById(doctor._id).lean();
};
