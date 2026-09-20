import { OnboardingSubmission, Hospital } from '../../models/index.js';
import { geocodeAddress } from '../../lib/providers/google-maps.js';
import { notFound, conflict, validationError } from '../../lib/errors.js';
import { assertSubmissionScope, scopeFilter } from '../../middleware/rbac.js';
import { emitSubmissionStatus } from '../../realtime/emitters.js';
import { SUBMISSION_STATUS, ROLES } from '../../config/constants.js';

export const create = async ({ body, actor }) =>
  OnboardingSubmission.create({
    kind: body.kind,
    agentId: actor.id,
    districtId: body.districtId || actor.districtId,
    status: SUBMISSION_STATUS.DRAFT,
    payload: body.payload,
    documents: body.documents || [],
  });

export const update = async ({ id, body, actor }) => {
  const sub = await OnboardingSubmission.findById(id);
  if (!sub) throw notFound('Submission not found');
  assertSubmissionScope(actor, sub);
  if (![SUBMISSION_STATUS.DRAFT, SUBMISSION_STATUS.CHANGES_REQUESTED].includes(sub.status)) {
    throw conflict('Only a draft or a submission with requested changes can be edited');
  }
  if (body.payload) sub.payload = { ...sub.payload, ...body.payload };
  if (body.documents) sub.documents = body.documents;
  await sub.save();
  return sub.toObject();
};

/** Submit for review. Geocoding happens here so the reviewer sees a real pin. */
export const submit = async ({ id, actor }) => {
  const sub = await OnboardingSubmission.findById(id);
  if (!sub) throw notFound('Submission not found');
  assertSubmissionScope(actor, sub);
  if (![SUBMISSION_STATUS.DRAFT, SUBMISSION_STATUS.CHANGES_REQUESTED].includes(sub.status)) {
    throw conflict('This submission has already been sent for review');
  }

  const p = sub.payload;
  if (sub.kind === 'HOSPITAL') {
    if (!p?.name || !p?.licenseNumber || !p?.address?.line1 || !p?.address?.pincode) {
      throw validationError([{ path: 'payload', message: 'Clinic name, licence number and full address are required' }]);
    }
    const clash = await Hospital.findOne({ licenseNumber: p.licenseNumber }).lean();
    if (clash) throw conflict('A clinic with this licence number is already registered');

    // The agent may already have pinned the clinic via Places on the form; in
    // that case trust it rather than paying for a second lookup that could
    // resolve the free-text address somewhere slightly different.
    if (p.geocode?.lat && p.geocode?.lng) {
      sub.geocodeResult = {
        lat: p.geocode.lat,
        lng: p.geocode.lng,
        formatted: p.geocode.formatted ?? '',
        placeId: p.geocode.placeId ?? '',
        accuracy: 'PLACES',
      };
    } else {
      const geo = await geocodeAddress(p.address);
      // Geocoding may be unavailable (no key, quota). Submitting still works;
      // the approval step is what refuses to activate a clinic with no coordinates.
      if (geo) sub.geocodeResult = geo;
    }
  }

  const from = sub.status;
  sub.status = SUBMISSION_STATUS.SUBMITTED;
  await sub.save();
  emitSubmissionStatus({ submission: sub, from, to: SUBMISSION_STATUS.SUBMITTED });
  return sub.toObject();
};

export const list = async ({ actor, status }) => {
  const scope = scopeFilter(actor);
  const filter = {};
  // An agent sees only their own submissions — the prototype leaked every
  // clinic in the network into "My Submissions".
  if (actor.role === ROLES.FIELD_AGENT) filter.agentId = actor.id;
  else if (scope.districtId) filter.districtId = scope.districtId;
  if (status) filter.status = status;
  return OnboardingSubmission.find(filter).sort({ createdAt: -1 }).lean();
};

export const getById = async ({ id, actor }) => {
  const sub = await OnboardingSubmission.findById(id).populate('agentId', 'name phone').lean();
  if (!sub) throw notFound('Submission not found');
  assertSubmissionScope(actor, sub);
  return sub;
};
