import { Doctor, Hospital } from '../../models/index.js';
import { findNearbyDoctors } from '../../services/nearbySearch.js';
import { notFound } from '../../lib/errors.js';
import { assertDoctorScope } from '../../middleware/rbac.js';
import { scopeFilter } from '../../middleware/rbac.js';
import { NETWORK_STATE } from '../../config/constants.js';

export const nearby = (params) => findNearbyDoctors(params);

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

export const updateProfile = async ({ doctorId, patch, actor }) => {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) throw notFound('Doctor not found');
  assertDoctorScope(actor, doctor, { selfOnly: false });
  await Doctor.updateOne({ _id: doctor._id }, { $set: patch });
  return Doctor.findById(doctor._id).lean();
};
