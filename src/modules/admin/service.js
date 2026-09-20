import { Hospital, OnboardingSubmission, AuditLog, OPDToken, Transaction, Doctor } from '../../models/index.js';
import { scopeFilter } from '../../middleware/rbac.js';
import { clinicDate } from '../../lib/dates.js';
import { NETWORK_STATE, SUBMISSION_STATUS, TOKEN_STATUS } from '../../config/constants.js';
export * from '../../services/lifecycle.js';

const districtScoped = (actor) => {
  const scope = scopeFilter(actor);
  return scope.districtId ? { districtId: scope.districtId } : {};
};

export const listApprovals = async ({ actor, status }) =>
  OnboardingSubmission.find({
    ...districtScoped(actor),
    status: status || { $in: [SUBMISSION_STATUS.SUBMITTED, SUBMISSION_STATUS.UNDER_REVIEW] },
  })
    .populate('agentId', 'name phone')
    .sort({ createdAt: -1 })
    .lean();

export const listHospitals = async ({ actor, networkState, search }) => {
  const filter = { ...districtScoped(actor) };
  if (networkState) filter.networkState = networkState;
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { code: new RegExp(search, 'i') }];
  return Hospital.find(filter).populate('districtId', 'name code').sort({ name: 1 }).lean();
};

export const getAudit = async ({ actor, entityType, entityId, limit = 100 }) => {
  const filter = { ...districtScoped(actor) };
  if (entityType) filter.entityType = entityType;
  if (entityId) filter.entityId = entityId;
  return AuditLog.find(filter).populate('actorId', 'name role').sort({ createdAt: -1 }).limit(limit).lean();
};

/**
 * District dashboard. Revenue counts COMPLETED consultations only — billing a
 * patient who was skipped or is still waiting overstates the day.
 */
export const dashboard = async ({ actor, date }) => {
  const scope = districtScoped(actor);
  const hospitals = await Hospital.find(scope).select('_id name code networkState districtId').lean();
  const ids = hospitals.map((h) => h._id);
  const day = date || clinicDate();

  const [revenue, footfall, pending, doctorCount] = await Promise.all([
    Transaction.aggregate([
      { $match: { hospitalId: { $in: ids }, date: day, status: 'PAID' } },
      { $lookup: { from: 'opdtokens', localField: 'tokenId', foreignField: '_id', as: 't' } },
      { $unwind: '$t' },
      { $match: { 't.status': TOKEN_STATUS.COMPLETED } },
      {
        $group: {
          _id: '$hospitalId',
          cash: { $sum: '$tender.cash' }, upi: { $sum: '$tender.upi' },
          card: { $sum: '$tender.card' }, total: { $sum: '$totalFee' }, count: { $sum: 1 },
        },
      },
    ]),
    OPDToken.aggregate([
      { $match: { hospitalId: { $in: ids }, date: day } },
      { $group: { _id: '$hospitalId', tokens: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.COMPLETED] }, 1, 0] } } } },
    ]),
    OnboardingSubmission.countDocuments({ ...scope, status: { $in: [SUBMISSION_STATUS.SUBMITTED, SUBMISSION_STATUS.UNDER_REVIEW] } }),
    Doctor.countDocuments({ hospitalId: { $in: ids }, isActive: true }),
  ]);

  const revBy = new Map(revenue.map((r) => [String(r._id), r]));
  const footBy = new Map(footfall.map((f) => [String(f._id), f]));

  const byHospital = hospitals.map((h) => {
    const r = revBy.get(String(h._id)) || { cash: 0, upi: 0, card: 0, total: 0, count: 0 };
    const f = footBy.get(String(h._id)) || { tokens: 0, completed: 0 };
    return {
      hospitalId: String(h._id), name: h.name, code: h.code, networkState: h.networkState,
      cash: r.cash, upi: r.upi, card: r.card, total: r.total,
      consultations: r.count, tokensIssued: f.tokens, completed: f.completed,
    };
  });

  const totals = byHospital.reduce(
    (a, h) => ({
      cash: a.cash + h.cash, upi: a.upi + h.upi, card: a.card + h.card,
      total: a.total + h.total, consultations: a.consultations + h.consultations,
      tokensIssued: a.tokensIssued + h.tokensIssued,
    }),
    { cash: 0, upi: 0, card: 0, total: 0, consultations: 0, tokensIssued: 0 },
  );

  return {
    date: day,
    basis: 'COMPLETED_ONLY',
    counts: {
      hospitals: hospitals.length,
      active: hospitals.filter((h) => h.networkState === NETWORK_STATE.ACTIVE).length,
      suspended: hospitals.filter((h) => h.networkState === NETWORK_STATE.SUSPENDED).length,
      deboarded: hospitals.filter((h) => h.networkState === NETWORK_STATE.DEBOARDED).length,
      pendingApprovals: pending,
      doctors: doctorCount,
    },
    totals,
    byHospital,
  };
};
