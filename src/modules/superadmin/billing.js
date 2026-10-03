import { Hospital, BillingCharge, BillingSettings, getBillingSettings } from '../../models/index.js';
import { NETWORK_STATE, AUDIT_ACTIONS } from '../../config/constants.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { isBillable, trialDaysLeft, resolveRule } from '../../services/billing.js';

/** Current month in the YYYY-MM form every charge row is bucketed by. */
const thisMonth = () => new Date().toISOString().slice(0, 7);

export const readSettings = async () => {
  const s = await getBillingSettings();
  return s.toObject ? s.toObject() : s;
};

export const updateSettings = async ({ patch, actor, ip, userAgent }) => {
  const before = await getBillingSettings();
  const fields = [
    'onlineRatePaise', 'offlineRatePaise', 'chargeMode', 'percentBps',
    'maxTrialDays', 'defaultTrialDays', 'maxMonthlyChargePaise', 'arrearsFlagPaise',
  ];
  const $set = { updatedBy: actor.id };
  for (const f of fields) if (patch[f] !== undefined) $set[f] = patch[f];

  await BillingSettings.updateOne({ _id: 'singleton' }, { $set }, { upsert: true });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.BILLING_SETTINGS_UPDATED,
    entityType: 'BillingSettings', entityId: before._id,
    before: { onlineRatePaise: before.onlineRatePaise, offlineRatePaise: before.offlineRatePaise, maxTrialDays: before.maxTrialDays },
    after: $set, ip, userAgent,
  });
  return readSettings();
};

/**
 * Every clinic's trial and billing position, in one call.
 *
 * Buckets are what Super Admin actually asks for: who is still on trial, who
 * runs out this week, who runs out this month, and who has run up a balance
 * worth chasing. Computed here rather than in the client so the thresholds
 * mean the same thing everywhere.
 */
export const overview = async () => {
  const settings = await getBillingSettings();
  const month = thisMonth();
  const now = new Date();

  const hospitals = await Hospital.find(
    { networkState: { $ne: NETWORK_STATE.DEBOARDED } },
    { name: 1, code: 1, networkState: 1, districtId: 1, trial: 1, billingOverride: 1, subscriptionPlan: 1 },
  ).lean();

  // One aggregate for the whole network, then joined in memory: a per-clinic
  // query would be N round-trips for a page that renders every clinic.
  const [monthRows, outstandingRows] = await Promise.all([
    BillingCharge.aggregate([
      { $match: { month, status: { $ne: 'WAIVED' } } },
      { $group: { _id: '$hospitalId', total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
    ]),
    BillingCharge.aggregate([
      { $match: { status: 'ACCRUED' } },
      { $group: { _id: '$hospitalId', total: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
    ]),
  ]);
  const monthBy = new Map(monthRows.map((r) => [String(r._id), r]));
  const outBy = new Map(outstandingRows.map((r) => [String(r._id), r]));

  const rows = hospitals.map((h) => {
    const id = String(h._id);
    const daysLeft = trialDaysLeft(h, now);
    const billable = isBillable(h, now);
    const rule = resolveRule(settings, h);
    const outstanding = outBy.get(id)?.total || 0;
    return {
      id,
      name: h.name,
      code: h.code,
      networkState: h.networkState,
      districtId: h.districtId ? String(h.districtId) : null,
      trialEndsAt: h.trial?.endsAt ?? null,
      trialDays: h.trial?.days ?? null,
      daysLeft,
      // ON_TRIAL until the clock runs out, then BILLABLE. Never "blocked":
      // nothing in this system stops serving a clinic over money.
      status: !h.trial?.endsAt ? 'NO_TRIAL' : billable ? 'BILLABLE' : 'ON_TRIAL',
      monthToDatePaise: monthBy.get(id)?.total || 0,
      monthToDateCount: monthBy.get(id)?.count || 0,
      outstandingPaise: outstanding,
      flagged: settings.arrearsFlagPaise > 0 && outstanding >= settings.arrearsFlagPaise,
      hasOverride: Boolean(h.billingOverride?.chargeMode || h.billingOverride?.onlineRatePaise != null),
      effectiveRule: rule,
    };
  });

  const onTrial = rows.filter((r) => r.status === 'ON_TRIAL');
  return {
    settings: settings.toObject ? settings.toObject() : settings,
    rows,
    buckets: {
      onTrial: onTrial.length,
      expiringInWeek: onTrial.filter((r) => r.daysLeft !== null && r.daysLeft <= 7).length,
      expiringInMonth: onTrial.filter((r) => r.daysLeft !== null && r.daysLeft <= 30).length,
      billable: rows.filter((r) => r.status === 'BILLABLE').length,
      noTrial: rows.filter((r) => r.status === 'NO_TRIAL').length,
      flagged: rows.filter((r) => r.flagged).length,
    },
    totals: {
      monthToDatePaise: rows.reduce((a, r) => a + r.monthToDatePaise, 0),
      outstandingPaise: rows.reduce((a, r) => a + r.outstandingPaise, 0),
    },
  };
};

/** Charge rows for one clinic, newest first — the drill-down behind a row. */
export const chargesFor = async ({ hospitalId, month }) => {
  const q = { hospitalId };
  if (month) q.month = month;
  const charges = await BillingCharge.find(q).sort({ createdAt: -1 }).limit(500).lean();
  return charges.map((c) => ({
    id: String(c._id),
    date: c.date,
    source: c.source,
    channel: c.channel,
    amountPaise: c.amountPaise,
    chargeMode: c.chargeMode,
    cappedBy: c.cappedBy,
    status: c.status,
  }));
};
