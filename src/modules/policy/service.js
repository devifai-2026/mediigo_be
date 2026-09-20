import { PatientPolicy, User, District } from '../../models/index.js';
import { analyzeGaps } from '../../services/policyGapEngine.js';
import { aadhaarHash, isValidAadhaar } from '../../lib/crypto.js';
import { validationError, notFound, forbidden } from '../../lib/errors.js';
import { ROLES } from '../../config/constants.js';

/**
 * The raw Aadhaar number is hashed at the edge and never stored, never logged,
 * and never returned. Only the HMAC leaves this function.
 */
export const hashAadhaarInput = (aadhaarNumber) => {
  if (!isValidAadhaar(aadhaarNumber)) {
    throw validationError([{ path: 'aadhaarNumber', message: 'Enter a valid 12-digit Aadhaar number' }]);
  }
  return aadhaarHash(aadhaarNumber);
};

const assertVaultAccess = (actor, patientId) => {
  if ([ROLES.SUPER_ADMIN, ROLES.EXEC_ADMIN, ROLES.FIELD_AGENT].includes(actor.role)) return;
  if (actor.role === ROLES.PATIENT && String(patientId) === String(actor.id)) return;
  throw forbidden('You can only view your own policy vault');
};

export const lookupVault = async ({ aadhaarNumber, actor }) => {
  const hash = hashAadhaarInput(aadhaarNumber);

  const policies = await PatientPolicy.find({ aadhaarHash: hash, isActive: true }).lean();
  // The vault works for someone who has not registered yet (an agent scanning at
  // a camp), so a missing user is not an error.
  const patient = await User.findOne({ aadhaarHash: hash }).lean();
  if (patient) assertVaultAccess(actor, patient._id);

  return {
    aadhaarHash: hash,
    linked: Boolean(patient),
    patient: patient ? { id: String(patient._id), name: patient.name, phone: patient.phone } : null,
    policyCount: policies.length,
    policies,
  };
};

export const listPolicies = async ({ aadhaarHash: hash, actor }) => {
  const patient = await User.findOne({ aadhaarHash: hash }).lean();
  if (patient) assertVaultAccess(actor, patient._id);
  return PatientPolicy.find({ aadhaarHash: hash, isActive: true }).sort({ sumInsured: -1 }).lean();
};

export const gapAnalysis = async ({ aadhaarHash: hash, actor }) => {
  const [policies, patient] = await Promise.all([
    PatientPolicy.find({ aadhaarHash: hash, isActive: true }).lean(),
    User.findOne({ aadhaarHash: hash }).lean(),
  ]);
  if (patient) assertVaultAccess(actor, patient._id);

  // District drives the benchmark tier. Fall back to the actor's district when
  // the policy has none recorded.
  const districtId = policies.find((p) => p.sourceDistrictId)?.sourceDistrictId || actor?.districtId;
  const district = districtId ? await District.findById(districtId).lean() : null;

  return analyzeGaps({ policies, district, patient });
};

export const addPolicy = async ({ body, actor }) => {
  const hash = body.aadhaarNumber ? hashAadhaarInput(body.aadhaarNumber) : body.aadhaarHash;
  if (!hash) throw validationError([{ path: 'aadhaarNumber', message: 'Aadhaar number or hash is required' }]);

  const patient = await User.findOne({ aadhaarHash: hash }).lean();
  if (patient) assertVaultAccess(actor, patient._id);

  const doc = { ...body, aadhaarHash: hash, patientId: patient?._id ?? null, capturedBy: actor.id };
  delete doc.aadhaarNumber;
  return PatientPolicy.create(doc);
};

export const updatePolicy = async ({ policyId, patch, actor }) => {
  const policy = await PatientPolicy.findById(policyId);
  if (!policy) throw notFound('Policy not found');
  if (policy.patientId) assertVaultAccess(actor, policy.patientId);
  delete patch.aadhaarNumber;
  delete patch.aadhaarHash;
  await PatientPolicy.updateOne({ _id: policy._id }, { $set: patch });
  return PatientPolicy.findById(policy._id).lean();
};

/** Called after a patient registers, to attach camp-captured policies. */
export const backfillPatientLink = async (patientId, hash) =>
  PatientPolicy.updateMany({ aadhaarHash: hash, patientId: null }, { $set: { patientId } });
