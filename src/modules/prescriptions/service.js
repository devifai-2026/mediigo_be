import { Prescription, OPDToken, Doctor, Hospital, User } from '../../models/index.js';
import { forbidden, notFound, conflict } from '../../lib/errors.js';
import { assertHospitalScope } from '../../middleware/rbac.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { AUDIT_ACTIONS, PHARMACY_STATUS, ROLES, TOKEN_SOURCE, TOKEN_STATUS } from '../../config/constants.js';
import { emitPharmacyRx } from '../../realtime/emitters.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** The presenting complaint plus declared conditions, as one line. */
export const symptomsOf = (token) => [
  token.patientSnapshot?.complaint,
  ...(token.patientSnapshot?.conditions ?? []).map((c) => `k/c/o ${c}`),
].filter(Boolean).join('; ');

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
    Hospital.findById(token.hospitalId).select('_id districtId name').lean(),
  ]);
  assertHospitalScope(actor, hospital);
  // Checked before writing, so a failed send never leaves a saved pad behind
  // for the doctor to save a second time.
  if (body.sendToPharmacy && !(await clinicHasPharmacy(token.hospitalId))) {
    throw conflict('This clinic has no pharmacy login yet. Add one from Profile → Clinic pharmacy.');
  }

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
    symptoms: body.symptoms?.trim() || symptomsOf(token),
    diagnosis: body.diagnosis,
    medicines: body.medicines,
    advice: body.advice,
    reviewDate: body.reviewDate || null,
    totalDue: body.totalDue ?? null,
    hospitalName: hospital?.name ?? '',
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

  if (body.sendToPharmacy) return sendToPharmacy({ id: rx._id, actor, justWritten: rx });
  return rx.toObject();
};

/** Whether a clinic has anyone at its pharmacy to send prescriptions to. */
export const clinicHasPharmacy = async (hospitalId) => Boolean(
  hospitalId && await User.exists({ hospitalId, role: ROLES.PHARMACIST, isActive: true }),
);

/**
 * Send a prescription to the clinic's pharmacy. Done while saving the pad, or
 * later from the EMR when the patient decides to buy here after all. Sending
 * twice is harmless: a prescription already at the pharmacy is left as it is.
 */
export const sendToPharmacy = async ({ id, actor, justWritten = null }) => {
  const rx = justWritten ?? await Prescription.findById(id).catch(() => null);
  if (!rx) throw notFound('Prescription not found');
  if (actor.role !== ROLES.SUPER_ADMIN && !sameId(rx.hospitalId, actor.hospitalId)) throw notFound('Prescription not found');
  if (actor.role === ROLES.DOCTOR && !sameId(rx.doctorId, actor.doctorId)) {
    throw forbidden('Only the prescribing doctor can send this to the pharmacy');
  }
  if (rx.pharmacy) return rx.toObject();
  if (!(await clinicHasPharmacy(rx.hospitalId))) {
    throw conflict('This clinic has no pharmacy login yet. Add one from Profile → Clinic pharmacy.');
  }

  rx.pharmacy = { status: PHARMACY_STATUS.PENDING, sentAt: new Date(), sentBy: actor.id };
  await rx.save();
  const out = rx.toObject();

  writeAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRESCRIPTION_SENT_TO_PHARMACY,
    entityType: 'Prescription',
    entityId: rx._id,
    hospitalId: rx.hospitalId,
  });
  emitPharmacyRx(out, { isNew: true });
  return out;
};

/**
 * Whose clinical records a staff member may read.
 *
 * A doctor sees only the consultations they gave: a patient's visit to a
 * colleague down the corridor is that colleague's record, not theirs. The
 * front desk and pharmacy work for the whole clinic. Nobody reads another
 * clinic's records.
 */
export const recordScope = (actor) => {
  if (actor.role === ROLES.SUPER_ADMIN) return {};
  if (actor.role === ROLES.DOCTOR) return { hospitalId: actor.hospitalId, doctorId: actor.doctorId };
  return { hospitalId: actor.hospitalId };
};

const inScope = (actor, rec) => Object.entries(recordScope(actor)).every(([k, v]) => sameId(rec[k], v));

/** Prescriptions the caller may read; see recordScope. */
export const listPrescriptions = async ({ query, actor }) => {
  const filter = {};
  if (query.patientId) filter.patientId = query.patientId;
  if (query.tokenId) filter.tokenId = query.tokenId;
  if (query.doctorId) filter.doctorId = query.doctorId;
  if (query.date) filter.date = query.date;
  if (!query.patientId && !query.tokenId && !query.date) {
    throw conflict('Name a patient, token or date');
  }
  return Prescription.find({ ...filter, ...recordScope(actor) }).sort({ createdAt: -1 }).limit(query.limit || 50).lean();
};

export const getPrescription = async ({ id, actor }) => {
  const rx = await Prescription.findById(id).lean().catch(() => null);
  if (!rx) throw notFound('Prescription not found');
  if (!inScope(actor, rx)) throw notFound('Prescription not found');
  return rx;
};

/**
 * A mobile number's recent visits at the caller's clinic, newest first, each
 * with whatever was prescribed. Keyed on the number rather than the account
 * because that is what the patient gives at the counter — and a family that
 * shares one phone should all come up together.
 *
 * Deliberately short (three visits by default): the full history is the
 * footfall register's job.
 */
export const lookupByPhone = async ({ query, actor }) => {
  const filter = { 'patientSnapshot.phone': query.phone, status: { $nin: [TOKEN_STATUS.CANCELLED] }, ...recordScope(actor) };
  const limit = query.visits || 3;
  const [tokens, total] = await Promise.all([
    OPDToken.find(filter)
      .select('tokenNumber date status visitType patientSnapshot doctorId createdAt completedAt outcome')
      .sort({ date: -1, createdAt: -1 }).limit(limit).lean(),
    OPDToken.countDocuments(filter),
  ]);
  const [rx, doctors] = await Promise.all([
    Prescription.find({ tokenId: { $in: tokens.map((t) => t._id) } }).sort({ createdAt: -1 }).lean(),
    Doctor.find({ _id: { $in: [...new Set(tokens.map((t) => String(t.doctorId)))] } }).select('name specialty').lean(),
  ]);
  const docById = new Map(doctors.map((d) => [String(d._id), d]));
  return {
    phone: query.phone,
    totalVisits: total,
    visits: tokens.map((t) => ({
      tokenId: String(t._id),
      tokenNumber: t.tokenNumber,
      date: t.date,
      status: t.status,
      visitType: t.visitType || 'fresh',
      outcome: t.outcome ?? null,
      patientName: t.patientSnapshot?.name || '',
      age: t.patientSnapshot?.age ?? null,
      gender: t.patientSnapshot?.gender ?? null,
      symptoms: symptomsOf(t),
      doctorName: docById.get(String(t.doctorId))?.name || '',
      prescriptions: rx.filter((r) => sameId(r.tokenId, t._id)),
    })),
  };
};

// ---- the patient's own records ---------------------------------------------

const SELF_BOOKED = new Set([TOKEN_SOURCE.APP, TOKEN_SOURCE.QR_SCAN]);

/**
 * The visits a patient chose Mediigo for: booked by them in the app or by
 * scanning the clinic's QR. A follow-up the doctor booked takes after the
 * visit it follows, so a walk-in's follow-up stays as private as the walk-in.
 * Decided per visit, not per person — a walk-in who joins the app later still
 * does not see visits they never booked through it.
 */
const selfBookedTokenIds = async (tokens) => {
  const byId = new Map(tokens.map((t) => [String(t._id), t]));
  // Follow-up chains are short; walk them a few links back.
  for (let hop = 0; hop < 5; hop += 1) {
    const missing = [...byId.values()]
      .map((t) => t.followUp?.sourceTokenId)
      .filter((id) => id && !byId.has(String(id)));
    if (!missing.length) break;
    // eslint-disable-next-line no-await-in-loop
    const more = await OPDToken.find({ _id: { $in: missing } }).select('source followUp.sourceTokenId').lean();
    more.forEach((t) => byId.set(String(t._id), t));
  }
  const root = (t, hops = 0) => {
    const src = t.followUp?.sourceTokenId && byId.get(String(t.followUp.sourceTokenId));
    return src && hops < 5 ? root(src, hops + 1) : t;
  };
  return new Set(tokens.filter((t) => SELF_BOOKED.has(root(t).source)).map((t) => String(t._id)));
};

/**
 * A signed-in patient's medical history: every prescription from a visit they
 * booked through Mediigo, for themselves or a family member on their account,
 * across all clinics, newest first.
 */
export const myPrescriptions = async ({ actor }) => {
  const rx = await Prescription.find({ patientId: actor.id }).sort({ createdAt: -1 }).limit(200).lean();
  if (!rx.length) return [];
  const tokens = await OPDToken.find({ _id: { $in: rx.map((r) => r.tokenId) } })
    .select('source familyMemberId followUp.sourceTokenId').lean();
  const visible = await selfBookedTokenIds(tokens);
  const member = new Map(tokens.map((t) => [String(t._id), t.familyMemberId ? String(t.familyMemberId) : null]));
  return rx
    .filter((r) => visible.has(String(r.tokenId)))
    .map((r) => ({
      id: String(r._id),
      date: r.date,
      writtenAt: r.createdAt,
      patientName: r.patientSnapshot?.name || '',
      familyMemberId: member.get(String(r.tokenId)) ?? null,
      doctor: r.doctorSnapshot,
      clinicName: r.hospitalName,
      symptoms: r.symptoms,
      diagnosis: r.diagnosis,
      medicines: r.medicines,
      advice: r.advice,
      reviewDate: r.reviewDate,
      pharmacy: r.pharmacy ? { status: r.pharmacy.status, unavailable: r.pharmacy.unavailable } : null,
    }));
};
