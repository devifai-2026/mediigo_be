import { OnboardingSubmission, Hospital, Doctor, User, ClinicLead, LEAD_STAGE } from '../../models/index.js';
import { doctorPayloadSchema, clinicExtrasSchema } from '../doctors/profileFields.js';
import { geocodeAddress } from '../../lib/providers/google-maps.js';
import { notFound, conflict, validationError } from '../../lib/errors.js';
import { assertSubmissionScope, scopeFilter } from '../../middleware/rbac.js';
import { emitSubmissionStatus } from '../../realtime/emitters.js';
import { assertLeadOnboardable } from './leads.js';
import { SUBMISSION_STATUS, ROLES } from '../../config/constants.js';

export const create = async ({ body, actor }) => {
  // Onboarding a clinic from the agent's follow-up list: the lead must be
  // theirs, and it must not already have been submitted.
  let lead = null;
  if (body.leadId) {
    lead = await ClinicLead.findById(body.leadId);
    if (!lead || String(lead.agentId) !== String(actor.id)) throw notFound('Lead not found');
    // A rejected clinic may be resubmitted; anything else is still in review or done.
    await assertLeadOnboardable(lead);
  }
  const sub = await OnboardingSubmission.create({
    kind: body.kind,
    agentId: actor.id,
    districtId: body.districtId || actor.districtId,
    status: SUBMISSION_STATUS.DRAFT,
    payload: body.payload,
    documents: body.documents || [],
    leadId: lead?._id ?? null,
  });
  return sub;
};

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
    // Also against clinics still awaiting review: two pending submissions with
    // one code would otherwise both pass, and approving the second would
    // overwrite the first clinic.
    const code = String(p.code || '').toUpperCase();
    const codeTaken = code && (await Hospital.exists({ code }) || await OnboardingSubmission.exists({
      _id: { $ne: sub._id }, kind: 'HOSPITAL', 'payload.code': code,
      status: { $in: [SUBMISSION_STATUS.SUBMITTED, SUBMISSION_STATUS.UNDER_REVIEW] },
    }));
    if (codeTaken) throw conflict(`Clinic code ${code} is taken — pick another`);

    // The clinic's doctors, timings and facilities, when the agent captured
    // them. Checked now so approval can create every account in one go.
    const extras = clinicExtrasSchema.safeParse(p);
    if (!extras.success) {
      throw validationError(extras.error.issues.map((i) => ({ path: `payload.${i.path.join('.')}`, message: i.message })));
    }
    const doctors = extras.data.doctors ?? [];
    if (doctors.length) {
      const phones = [p.primaryContact?.phone, ...doctors.map((d) => d.phone)].filter(Boolean);
      const dupPhone = phones.find((ph, i) => phones.indexOf(ph) !== i);
      if (dupPhone) throw conflict(`Mobile ${dupPhone} is used twice — every login needs its own number`);
      const regs = doctors.map((d) => d.councilRegNo.toUpperCase());
      const dupReg = regs.find((r, i) => regs.indexOf(r) !== i);
      if (dupReg) throw conflict(`Registration number ${dupReg} is entered for two doctors`);
      const takenPhone = await User.findOne({ phone: { $in: phones } }).select('phone').lean();
      if (takenPhone) throw conflict(`Mobile ${takenPhone.phone} already has a Mediigo account`);
      const takenReg = await Doctor.findOne({ councilRegNo: { $in: doctors.map((d) => d.councilRegNo) } }).select('councilRegNo').lean();
      if (takenReg) throw conflict(`A doctor with registration ${takenReg.councilRegNo} is already on Mediigo`);
      if (doctors.filter((d) => d.isClinicAdmin).length > 1) throw conflict('Only one doctor can be the clinic admin');
    }
    sub.payload = { ...p, ...extras.data };
    sub.markModified('payload');

    // The agent may already have pinned the clinic via Places on the form; in
    // that case trust it rather than paying for a second lookup that could
    // resolve the free-text address somewhere slightly different.
    if (p.geocode?.lat && p.geocode?.lng) {
      sub.geocodeResult = {
        lat: p.geocode.lat,
        lng: p.geocode.lng,
        formatted: p.geocode.formatted ?? '',
        placeId: p.geocode.placeId ?? '',
        // A pin dropped on the map by hand is the most exact of all — the
        // agent was looking at the building.
        accuracy: p.geocode.source === 'MAP_PIN' ? 'MAP_PIN' : 'PLACES',
      };
    } else {
      const geo = await geocodeAddress(p.address);
      // Geocoding may be unavailable (no key, quota). Submitting still works;
      // the approval step is what refuses to activate a clinic with no coordinates.
      if (geo) sub.geocodeResult = geo;
    }
  }

  if (sub.kind === 'DOCTOR') {
    // Checked here, not at approval: a reviewer should never open a doctor
    // that cannot be created, and the unique indexes would otherwise surface
    // as an unexplained duplicate-key error on the approve button.
    const parsed = doctorPayloadSchema.safeParse(p || {});
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((i) => ({ path: `payload.${i.path.join('.')}`, message: i.message })));
    }
    const d = parsed.data;
    if (await Doctor.exists({ councilRegNo: d.councilRegNo })) {
      throw conflict('A doctor with this council registration number is already registered');
    }
    if (await User.exists({ phone: d.phone })) {
      throw conflict('This mobile number already has a Mediigo account');
    }
    sub.payload = d;
    sub.markModified('payload');
  }

  const from = sub.status;
  sub.status = SUBMISSION_STATUS.SUBMITTED;
  sub.submittedAt = new Date();
  await sub.save();

  // The prospect it came from is now in the approval pipeline.
  if (sub.leadId) {
    await ClinicLead.updateOne(
      { _id: sub.leadId },
      {
        $set: { stage: LEAD_STAGE.SUBMITTED, submissionId: sub._id, submittedAt: sub.submittedAt, nextVisitAt: null },
        $push: { visits: { at: sub.submittedAt, outcome: 'ONBOARDED', note: 'Submitted for district approval' } },
      },
    );
  }
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
  return OnboardingSubmission.find(filter)
    .populate('reviewedBy', 'name')
    .sort({ createdAt: -1 })
    .lean();
};

export const getById = async ({ id, actor }) => {
  const sub = await OnboardingSubmission.findById(id).populate('agentId', 'name phone').lean();
  if (!sub) throw notFound('Submission not found');
  assertSubmissionScope(actor, sub);
  return sub;
};
