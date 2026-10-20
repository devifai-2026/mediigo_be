import { DoctorEnquiry, ENQUIRY_STATUS, ClinicLead, LEAD_STAGE, District, User, getBillingSettings } from '../../models/index.js';
import { notFound, validationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { ROLES } from '../../config/constants.js';

const OPEN_STAGES = [LEAD_STAGE.NEW, LEAD_STAGE.FOLLOW_UP, LEAD_STAGE.INTERESTED];
// A second submission from the same number inside this window is the same
// enquiry — someone double-tapping, or coming back from the ad again.
const REPEAT_WINDOW_MS = 7 * 86400000;
// How soon the agent should call back. Lands in "Due now" and on today's calendar.
const CALLBACK_IN_MS = 60 * 60000;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

/** "Pune" → Pune City; "pimpri" → Pimpri-Chinchwad. Null when no district covers it. */
const districtForCity = async (city) => {
  const c = norm(city);
  if (c.length < 3) return null;
  const districts = await District.find({}).select('name').lean();
  return districts.find((d) => norm(d.name) === c)
    ?? districts.find((d) => norm(d.name).startsWith(c) || c.startsWith(norm(d.name)))
    ?? districts.find((d) => norm(d.name).includes(c))
    ?? null;
};

/** The active field agent in the district with the fewest open leads. */
const agentForDistrict = async (districtId) => {
  const agents = await User.find({ role: ROLES.FIELD_AGENT, districtId, isActive: { $ne: false } }).select('_id name').lean();
  if (!agents.length) return null;
  const load = await ClinicLead.aggregate([
    { $match: { agentId: { $in: agents.map((a) => a._id) }, stage: { $in: OPEN_STAGES } } },
    { $group: { _id: '$agentId', n: { $sum: 1 } } },
  ]);
  const byAgent = new Map(load.map((l) => [String(l._id), l.n]));
  return agents.sort((a, b) => (byAgent.get(String(a._id)) ?? 0) - (byAgent.get(String(b._id)) ?? 0))[0];
};

const leadNotes = (e) => [
  'Website enquiry — they asked for a call back.',
  e.doctorsCount && `Doctors: ${e.doctorsCount}.`,
  e.preferredTime && `Best time to call: ${e.preferredTime}.`,
  e.email && `Email: ${e.email}.`,
  e.message && `Message: ${e.message}`,
  e.utm?.campaign && `Campaign: ${[e.utm.source, e.utm.campaign].filter(Boolean).join(' / ')}.`,
].filter(Boolean).join(' ').slice(0, 1000);

/** Put an enquiry into one agent's follow-ups, or move it to another agent. */
const assignTo = async (enquiry, agent, districtId) => {
  const fields = {
    agentId: agent._id,
    districtId,
    clinicName: enquiry.clinicName || `${enquiry.name} (clinic name not given)`,
    contactName: enquiry.name,
    contactPhone: enquiry.phone,
    specialty: enquiry.specialty,
    address: { city: enquiry.city },
    notes: leadNotes(enquiry),
  };
  let lead = enquiry.leadId ? await ClinicLead.findById(enquiry.leadId) : null;
  if (lead) {
    Object.assign(lead, fields);
    if (OPEN_STAGES.includes(lead.stage) && !lead.nextVisitAt) lead.nextVisitAt = new Date(Date.now() + CALLBACK_IN_MS);
    await lead.save();
  } else {
    lead = await ClinicLead.create({
      ...fields,
      source: 'ENQUIRY',
      enquiryId: enquiry._id,
      stage: LEAD_STAGE.NEW,
      nextVisitAt: new Date(Date.now() + CALLBACK_IN_MS),
    });
  }
  enquiry.leadId = lead._id;
  enquiry.agentId = agent._id;
  enquiry.districtId = districtId;
  enquiry.status = ENQUIRY_STATUS.ASSIGNED;
  await enquiry.save();
  return lead;
};

/**
 * Public: the landing page form. Never tells the visitor whether an agent was
 * found — that is our problem, not theirs.
 */
export const submitEnquiry = async ({ body, ip, userAgent }) => {
  // Honeypot: a field people never see. Bots fill it; pretend all is well.
  if (body.website) {
    logger.info({ ip }, 'enquiry honeypot tripped');
    return { ok: true };
  }

  const recent = await DoctorEnquiry.findOne({ phone: body.phone, createdAt: { $gte: new Date(Date.now() - REPEAT_WINDOW_MS) } });
  if (recent) {
    // Keep what they told us this time, but do not start a second follow-up.
    for (const k of ['name', 'email', 'clinicName', 'city', 'specialty', 'doctorsCount', 'preferredTime', 'message']) {
      if (body[k]) recent[k] = body[k];
    }
    recent.submissions += 1;
    recent.lastSubmittedAt = new Date();
    await recent.save();
    if (recent.leadId) {
      await ClinicLead.updateOne({ _id: recent.leadId }, { $set: { notes: leadNotes(recent) } });
    }
    return { ok: true };
  }

  const enquiry = await DoctorEnquiry.create({
    ...body,
    utm: body.utm ?? {},
    ip: ip || '',
    userAgent: String(userAgent || '').slice(0, 300),
  });

  const district = await districtForCity(body.city);
  const agent = district ? await agentForDistrict(district._id) : null;
  if (agent) {
    await assignTo(enquiry, agent, district._id);
  } else {
    enquiry.districtId = district?._id ?? null;
    await enquiry.save();
    logger.info({ enquiryId: String(enquiry._id), city: body.city }, 'enquiry has no field agent for its city — left for super admin');
  }
  return { ok: true };
};

/** Public: what the pricing section shows, straight from billing settings. */
export const publicPricing = async () => {
  const s = await getBillingSettings();
  return {
    onlineRate: s.onlineRatePaise / 100,
    offlineRate: s.offlineRatePaise / 100,
    chargeMode: s.chargeMode,
    percent: s.percentBps / 100,
    trialDays: s.defaultTrialDays,
    monthlyCap: s.maxMonthlyChargePaise ? s.maxMonthlyChargePaise / 100 : null,
  };
};

// ---- super admin ------------------------------------------------------------

export const listEnquiries = async ({ status, q } = {}) => {
  const filter = {};
  if (status && Object.values(ENQUIRY_STATUS).includes(status)) filter.status = status;
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { clinicName: rx }, { phone: rx }, { city: rx }, { 'utm.campaign': rx }];
  }
  const [items, counts] = await Promise.all([
    DoctorEnquiry.find(filter).sort({ createdAt: -1 }).limit(300)
      .populate('agentId', 'name phone')
      .populate('districtId', 'name')
      .populate('leadId', 'stage nextVisitAt')
      .lean(),
    DoctorEnquiry.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  return {
    items: items.map((e) => ({
      id: String(e._id),
      name: e.name,
      phone: e.phone,
      email: e.email,
      clinicName: e.clinicName,
      city: e.city,
      specialty: e.specialty,
      doctorsCount: e.doctorsCount,
      preferredTime: e.preferredTime,
      message: e.message,
      utm: e.utm,
      status: e.status,
      submissions: e.submissions,
      createdAt: e.createdAt,
      district: e.districtId ? { id: String(e.districtId._id), name: e.districtId.name } : null,
      agent: e.agentId ? { id: String(e.agentId._id), name: e.agentId.name, phone: e.agentId.phone } : null,
      lead: e.leadId ? { stage: e.leadId.stage, nextVisitAt: e.leadId.nextVisitAt } : null,
    })),
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
  };
};

export const assignEnquiry = async ({ id, agentId }) => {
  const enquiry = await DoctorEnquiry.findById(id);
  if (!enquiry) throw notFound('Enquiry not found');
  const agent = await User.findOne({ _id: agentId, role: ROLES.FIELD_AGENT }).select('_id name districtId').lean();
  if (!agent) throw validationError([{ path: 'agentId', message: 'Pick a field agent' }]);
  await assignTo(enquiry, agent, agent.districtId ?? enquiry.districtId);
  return { ok: true };
};

export const markSpam = async ({ id }) => {
  const enquiry = await DoctorEnquiry.findById(id);
  if (!enquiry) throw notFound('Enquiry not found');
  enquiry.status = ENQUIRY_STATUS.SPAM;
  await enquiry.save();
  // An open follow-up for spam is just noise in the agent's list.
  if (enquiry.leadId) await ClinicLead.updateOne({ _id: enquiry.leadId, stage: LEAD_STAGE.NEW }, { $set: { stage: LEAD_STAGE.NOT_INTERESTED, nextVisitAt: null } });
  return { ok: true };
};
