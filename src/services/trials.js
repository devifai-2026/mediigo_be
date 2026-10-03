import { Hospital, getBillingSettings } from '../models/index.js';
import { ROLES, AUDIT_ACTIONS } from '../config/constants.js';
import { validationError, notFound, forbidden } from '../lib/errors.js';
import { assertHospitalScope } from '../middleware/rbac.js';
import { writeAuditLog } from '../lib/auditLog.js';

/**
 * Free trials.
 *
 * A District Admin decides how long the clinics they onboard get, but only
 * Super Admin sets the ceiling they choose within — the same shape as the rest
 * of this codebase, where a district actor acts freely inside their district
 * and the global rule belongs to one role above them.
 */

export const addDays = (from, days) => new Date(new Date(from).getTime() + days * 86400000);

/**
 * Validate a requested trial length against the platform ceiling.
 * Super Admin is bound by it too: the cap is a stated policy, not a
 * permission, and a quiet exception from the top is how policy stops meaning
 * anything. Raising the ceiling is a visible, audited act — exceeding it
 * silently is not.
 */
export const assertTrialLength = async (days) => {
  const settings = await getBillingSettings();
  const n = Number(days);
  if (!Number.isInteger(n) || n < 0) throw validationError('Trial length must be a whole number of days');
  if (n > settings.maxTrialDays) {
    throw validationError(`Trial cannot exceed ${settings.maxTrialDays} days — raise the platform maximum first`);
  }
  return n;
};

/** Build the trial subdocument for a hospital being approved. */
export const buildTrial = async ({ days, actor, now = new Date() }) => {
  const settings = await getBillingSettings();
  const n = await assertTrialLength(days ?? settings.defaultTrialDays);
  if (n === 0) return { startsAt: null, endsAt: null, days: 0, grantedBy: actor?.id ?? null, grantedAt: now };
  return {
    startsAt: now,
    endsAt: addDays(now, n),
    days: n,
    grantedBy: actor?.id ?? null,
    grantedAt: now,
  };
};

/** Extend or re-grant a trial on a live clinic. */
export const setTrial = async ({ hospitalId, days, actor, ip, userAgent }) => {
  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) throw notFound('Clinic not found');
  assertHospitalScope(actor, hospital);
  const n = await assertTrialLength(days);

  const now = new Date();
  // Extending runs from today, not from the original start: a clinic granted
  // another 30 days means 30 more from now, which is what anyone saying it
  // means. Counting from the original start would hand over an already-spent
  // trial and look like a bug to the clinic.
  const trial = n === 0
    ? { startsAt: null, endsAt: null, days: 0, grantedBy: actor.id, grantedAt: now }
    : { startsAt: hospital.trial?.startsAt || now, endsAt: addDays(now, n), days: n, grantedBy: actor.id, grantedAt: now };

  await Hospital.updateOne({ _id: hospital._id }, { $set: { trial } });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.TRIAL_GRANTED,
    entityType: 'Hospital', entityId: hospital._id, hospitalId: hospital._id,
    districtId: hospital.districtId, reason: `Trial set to ${n} days`, ip, userAgent,
  });
  return Hospital.findById(hospital._id).lean();
};

/** Per-tenant billing override. Super Admin only — this is a commercial term. */
export const setBillingOverride = async ({ hospitalId, patch, actor, ip, userAgent }) => {
  if (actor.role !== ROLES.SUPER_ADMIN) throw forbidden('Only Super Admin can change a clinic\'s billing terms');
  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) throw notFound('Clinic not found');

  const billingOverride = {
    ...(hospital.billingOverride?.toObject?.() ?? hospital.billingOverride ?? {}),
    ...patch,
    updatedBy: actor.id,
    updatedAt: new Date(),
  };
  await Hospital.updateOne({ _id: hospital._id }, { $set: { billingOverride } });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.BILLING_OVERRIDE_UPDATED,
    entityType: 'Hospital', entityId: hospital._id, hospitalId: hospital._id,
    districtId: hospital.districtId, reason: 'Billing terms changed', ip, userAgent,
  });
  return Hospital.findById(hospital._id).lean();
};
