import mongoose from 'mongoose';
import {
  ClinicLead, LEAD_STAGE, VISIT_OUTCOME, OnboardingSubmission, Hospital, OPDToken, Transaction, User,
} from '../../models/index.js';
import { notFound, conflict, validationError, forbidden } from '../../lib/errors.js';
import { ROLES, SUBMISSION_STATUS, NETWORK_STATE } from '../../config/constants.js';

/**
 * A field agent's prospects and follow-ups, and their monthly performance.
 *
 * An agent works only their own leads. A district admin may read the leads
 * and performance of agents in their district; the super admin, anyone's.
 */

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

const assertLeadAccess = (actor, lead, { write = false } = {}) => {
  if (!lead) throw notFound('Clinic not found');
  if (actor.role === ROLES.SUPER_ADMIN) return;
  if (actor.role === ROLES.FIELD_AGENT && sameId(lead.agentId, actor.id)) return;
  if (!write && actor.role === ROLES.EXEC_ADMIN && sameId(lead.districtId, actor.districtId)) return;
  throw notFound('Clinic not found');
};

// Which stage a visit outcome moves the lead to. MET and NOT_AVAILABLE leave
// an undecided clinic in follow-up; an explicit answer moves it.
const STAGE_AFTER = {
  [VISIT_OUTCOME.MET]: LEAD_STAGE.FOLLOW_UP,
  [VISIT_OUTCOME.RESCHEDULED]: LEAD_STAGE.FOLLOW_UP,
  [VISIT_OUTCOME.NOT_AVAILABLE]: LEAD_STAGE.FOLLOW_UP,
  [VISIT_OUTCOME.INTERESTED]: LEAD_STAGE.INTERESTED,
  [VISIT_OUTCOME.NOT_INTERESTED]: LEAD_STAGE.NOT_INTERESTED,
};

/** Attach the live approval status of each lead's submission. */
const withSubmissions = async (leads) => {
  const ids = leads.map((l) => l.submissionId).filter(Boolean);
  if (!ids.length) return leads;
  const subs = await OnboardingSubmission.find({ _id: { $in: ids } })
    .select('status submittedAt reviewedAt rejectionReason reviewNotes createdHospitalId')
    .lean();
  const byId = new Map(subs.map((s) => [String(s._id), s]));
  return leads.map((l) => ({ ...l, submission: l.submissionId ? byId.get(String(l.submissionId)) ?? null : null }));
};

export const listLeads = async ({ actor, query = {} }) => {
  const filter = {};
  if (actor.role === ROLES.FIELD_AGENT) filter.agentId = actor.id;
  else if (actor.role === ROLES.EXEC_ADMIN) filter.districtId = actor.districtId;
  if (/^[a-f0-9]{24}$/i.test(query.agentId || '') && actor.role !== ROLES.FIELD_AGENT) filter.agentId = query.agentId;
  if (Object.values(LEAD_STAGE).includes(query.stage)) filter.stage = query.stage;
  const leads = await ClinicLead.find(filter).sort({ nextVisitAt: 1, updatedAt: -1 }).limit(500).lean();
  return withSubmissions(leads);
};

export const createLead = async ({ body, actor }) => {
  const firstVisit = body.visit;
  if (firstVisit && STAGE_AFTER[firstVisit.outcome] === LEAD_STAGE.FOLLOW_UP && !firstVisit.nextVisitAt) {
    throw validationError([{ path: 'visit.nextVisitAt', message: 'Set when to go back' }]);
  }
  const lead = await ClinicLead.create({
    agentId: actor.id,
    districtId: actor.districtId || null,
    clinicName: body.clinicName,
    contactName: body.contactName || '',
    contactPhone: body.contactPhone || '',
    specialty: body.specialty || '',
    address: body.address || {},
    notes: body.notes || '',
    stage: firstVisit ? STAGE_AFTER[firstVisit.outcome] ?? LEAD_STAGE.NEW : LEAD_STAGE.NEW,
    nextVisitAt: firstVisit?.nextVisitAt ?? body.nextVisitAt ?? null,
    visits: firstVisit ? [{ ...firstVisit, at: new Date() }] : [],
  });
  return (await withSubmissions([lead.toObject()]))[0];
};

export const updateLead = async ({ id, body, actor }) => {
  const lead = await ClinicLead.findById(id);
  assertLeadAccess(actor, lead, { write: true });
  for (const k of ['clinicName', 'contactName', 'contactPhone', 'specialty', 'notes']) {
    if (body[k] !== undefined) lead[k] = body[k];
  }
  if (body.address) lead.address = { ...lead.address?.toObject?.(), ...body.address };
  if (body.nextVisitAt !== undefined) lead.nextVisitAt = body.nextVisitAt;
  await lead.save();
  return (await withSubmissions([lead.toObject()]))[0];
};

/**
 * Record a visit. A follow-up outcome must say when to go back, or the
 * clinic would silently drop out of the agent's list.
 */
export const logVisit = async ({ id, body, actor }) => {
  const lead = await ClinicLead.findById(id);
  assertLeadAccess(actor, lead, { write: true });
  if (lead.stage === LEAD_STAGE.SUBMITTED) {
    const sub = lead.submissionId ? await OnboardingSubmission.findById(lead.submissionId).select('status').lean() : null;
    if (sub && sub.status !== SUBMISSION_STATUS.REJECTED) {
      throw conflict('This clinic is already with the district admin for approval');
    }
  }
  if (body.outcome === VISIT_OUTCOME.ONBOARDED) {
    throw validationError([{ path: 'outcome', message: 'Onboard the clinic from the onboarding form' }]);
  }
  const next = STAGE_AFTER[body.outcome];
  if (next === LEAD_STAGE.FOLLOW_UP && !body.nextVisitAt) {
    throw validationError([{ path: 'nextVisitAt', message: 'Set when to go back' }]);
  }
  lead.visits.push({ at: new Date(), outcome: body.outcome, note: body.note || '', nextVisitAt: body.nextVisitAt || null });
  lead.stage = next;
  // An explicit answer either way ends the follow-up; interested keeps a date
  // if one was agreed (to come back with the onboarding forms).
  lead.nextVisitAt = next === LEAD_STAGE.NOT_INTERESTED ? null : (body.nextVisitAt || null);
  await lead.save();
  return (await withSubmissions([lead.toObject()]))[0];
};

/** May this lead be onboarded now? Used by the submission service. */
export const assertLeadOnboardable = async (lead) => {
  if (!lead.submissionId) return;
  const sub = await OnboardingSubmission.findById(lead.submissionId).select('status').lean();
  if (sub && sub.status !== SUBMISSION_STATUS.REJECTED) {
    throw conflict('This clinic has already been submitted for onboarding');
  }
};

// ---- Performance ------------------------------------------------------------

const monthBounds = (month) => {
  const [y, m] = month.split('-').map(Number);
  // Months are reckoned in IST, where the network operates.
  const start = new Date(Date.UTC(y, m - 1, 1) - 330 * 60000);
  const end = new Date(Date.UTC(y, m, 1) - 330 * 60000);
  return { start, end };
};
const isoDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const currentMonth = () => isoDay(new Date()).slice(0, 7);
const shiftMonth = (month, delta) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * One agent's month: what they submitted, what the district approved, how
 * long approval took, how much field work it took, and what the clinics they
 * brought in have done since.
 */
export const agentPerformance = async ({ actor, query = {} }) => {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : currentMonth();
  let agentId = actor.id;
  if (query.agentId && actor.role !== ROLES.FIELD_AGENT) agentId = query.agentId;
  const agent = await User.findById(agentId).select('name role districtId').populate('districtId', 'name').lean();
  if (!agent || agent.role !== ROLES.FIELD_AGENT) throw notFound('Agent not found');
  if (actor.role === ROLES.EXEC_ADMIN && !sameId(agent.districtId?._id ?? agent.districtId, actor.districtId)) {
    throw forbidden('That agent is not in your district');
  }

  const aid = new mongoose.Types.ObjectId(String(agentId));
  const { start, end } = monthBounds(month);
  const now = new Date();
  const [ty, tm, td] = isoDay(now).split('-').map(Number);
  const todayEnd = new Date(Date.UTC(ty, tm - 1, td + 1) - 330 * 60000);

  const [subs, leads, peers] = await Promise.all([
    OnboardingSubmission.find({ agentId: aid })
      .select('status submittedAt createdAt reviewedAt createdHospitalId payload.name rejectionReason')
      .lean(),
    ClinicLead.find({ agentId: aid }).select('stage nextVisitAt visits createdAt submittedAt').lean(),
    // District peers, for a rank. Approvals this month decide it.
    agent.districtId
      ? User.find({ role: ROLES.FIELD_AGENT, districtId: agent.districtId._id ?? agent.districtId, isActive: true }).select('_id name').lean()
      : [],
  ]);

  const inMonth = (d) => d && d >= start && d < end;
  const submittedAt = (s) => s.submittedAt || (s.status !== SUBMISSION_STATUS.DRAFT ? s.createdAt : null);

  const submitted = subs.filter((s) => inMonth(submittedAt(s)));
  const approved = subs.filter((s) => s.status === SUBMISSION_STATUS.APPROVED && inMonth(s.reviewedAt));
  const rejected = subs.filter((s) => s.status === SUBMISSION_STATUS.REJECTED && inMonth(s.reviewedAt));
  const pending = subs.filter((s) => [SUBMISSION_STATUS.SUBMITTED, SUBMISSION_STATUS.UNDER_REVIEW].includes(s.status));
  const approvalHours = approved
    .map((s) => (submittedAt(s) && s.reviewedAt ? (s.reviewedAt - submittedAt(s)) / 3600000 : null))
    .filter((h) => h != null && h >= 0);
  const oldestPending = pending.reduce((o, s) => (!o || submittedAt(s) < submittedAt(o) ? s : o), null);

  const visitsInMonth = leads.flatMap((l) => l.visits.filter((v) => inMonth(v.at) && v.outcome !== VISIT_OUTCOME.ONBOARDED));
  const clinicsVisited = leads.filter((l) => l.visits.some((v) => inMonth(v.at))).length;
  const outcomes = visitsInMonth.reduce((a, v) => ({ ...a, [v.outcome]: (a[v.outcome] || 0) + 1 }), {});
  const open = leads.filter((l) => [LEAD_STAGE.NEW, LEAD_STAGE.FOLLOW_UP, LEAD_STAGE.INTERESTED].includes(l.stage));
  const overdue = open.filter((l) => l.nextVisitAt && l.nextVisitAt < now);
  const dueToday = open.filter((l) => l.nextVisitAt && l.nextVisitAt >= now && l.nextVisitAt < todayEnd);

  // What the clinics this agent brought in have done this month.
  const hospitalIds = subs.filter((s) => s.createdHospitalId).map((s) => s.createdHospitalId);
  const startDay = isoDay(start);
  const endDay = isoDay(new Date(end.getTime() - 1));
  const [liveClinics, tokens, revenue] = hospitalIds.length ? await Promise.all([
    Hospital.countDocuments({ _id: { $in: hospitalIds }, networkState: NETWORK_STATE.ACTIVE }),
    OPDToken.countDocuments({ hospitalId: { $in: hospitalIds }, date: { $gte: startDay, $lte: endDay }, status: { $ne: 'CANCELLED' } }),
    Transaction.aggregate([
      { $match: { hospitalId: { $in: hospitalIds }, date: { $gte: startDay, $lte: endDay }, status: 'PAID' } },
      { $group: { _id: null, total: { $sum: '$totalFee' } } },
    ]),
  ]) : [0, 0, []];

  // Six months of submitted vs approved, ending with the chosen month.
  const trend = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5)).map((mo) => {
    const b = monthBounds(mo);
    const within = (d) => d && d >= b.start && d < b.end;
    return {
      month: mo,
      submitted: subs.filter((s) => within(submittedAt(s))).length,
      approved: subs.filter((s) => s.status === SUBMISSION_STATUS.APPROVED && within(s.reviewedAt)).length,
      visits: leads.reduce((a, l) => a + l.visits.filter((v) => within(v.at) && v.outcome !== VISIT_OUTCOME.ONBOARDED).length, 0),
    };
  });

  let rank = null;
  if (peers.length > 1) {
    const peerApprovals = await OnboardingSubmission.aggregate([
      { $match: { agentId: { $in: peers.map((p) => p._id) }, status: SUBMISSION_STATUS.APPROVED, reviewedAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$agentId', n: { $sum: 1 } } },
    ]);
    const counts = peers.map((p) => peerApprovals.find((r) => sameId(r._id, p._id))?.n ?? 0);
    const mine = approved.length;
    rank = { position: counts.filter((c) => c > mine).length + 1, of: peers.length, leaderApprovals: Math.max(...counts) };
  }

  return {
    month,
    agent: { id: String(agent._id), name: agent.name, district: agent.districtId?.name ?? null },
    onboarding: {
      submitted: submitted.length,
      approved: approved.length,
      rejected: rejected.length,
      pendingNow: pending.length,
      approvalRate: approved.length + rejected.length ? Math.round((approved.length / (approved.length + rejected.length)) * 100) : null,
      avgApprovalHours: approvalHours.length ? Math.round((approvalHours.reduce((a, b) => a + b, 0) / approvalHours.length) * 10) / 10 : null,
      oldestPendingSince: oldestPending ? submittedAt(oldestPending) : null,
      allTimeApproved: subs.filter((s) => s.status === SUBMISSION_STATUS.APPROVED).length,
    },
    field: {
      visits: visitsInMonth.length,
      clinicsVisited,
      newLeads: leads.filter((l) => inMonth(l.createdAt)).length,
      outcomes,
      // Of the clinics worked this month, how many reached submission.
      conversionRate: clinicsVisited ? Math.round((submitted.length / clinicsVisited) * 100) : null,
      openLeads: open.length,
      overdue: overdue.length,
      dueToday: dueToday.length,
    },
    impact: {
      liveClinics,
      patientsBooked: tokens,
      revenue: revenue[0]?.total ?? 0,
    },
    trend,
    rank,
  };
};
