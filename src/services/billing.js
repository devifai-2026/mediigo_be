import { BillingCharge, getBillingSettings } from '../models/index.js';
import { TOKEN_SOURCE } from '../config/constants.js';
import { logger } from '../lib/logger.js';
import { paise } from '../lib/money.js';

/**
 * Platform billing: what Mediigo charges a clinic for each token it handles.
 *
 * Two rules govern everything here.
 *
 * First, billing NEVER blocks care. Every entry point is wrapped so that a
 * failure to bill cannot fail a booking — a patient must not be turned away
 * because a ledger write timed out. Arrears are a commercial problem, settled
 * between humans; they are never enforced by withholding a queue token.
 *
 * Second, a charge is frozen at the moment it is incurred. Rates change; what
 * a clinic owed last Tuesday does not.
 */

// Online means the patient did it themselves on a screen — our app, or their
// own phone against the clinic's QR standee. Offline means staff keyed it in
// at the desk, whether the patient walked up or telephoned.
const ONLINE_SOURCES = new Set([TOKEN_SOURCE.APP, TOKEN_SOURCE.QR_SCAN]);

export const channelOf = (source) => (ONLINE_SOURCES.has(source) ? 'ONLINE' : 'OFFLINE');

/** A clinic is billable once its trial has run out. No trial set = not billable. */
export const isBillable = (hospital, now = new Date()) => {
  const endsAt = hospital?.trial?.endsAt;
  if (!endsAt) return false;
  return new Date(endsAt).getTime() <= now.getTime();
};

export const trialDaysLeft = (hospital, now = new Date()) => {
  const endsAt = hospital?.trial?.endsAt;
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - now.getTime();
  return Math.ceil(ms / 86400000);
};

/**
 * Which rule applies to this clinic, settings or its own override.
 *
 * A null override field falls through to the global setting, so the ordinary
 * clinic needs no override row at all and a negotiated one can differ in just
 * the single field that was negotiated.
 */
export const resolveRule = (settings, hospital) => {
  const o = hospital?.billingOverride || {};
  const pick = (a, b) => (a === null || a === undefined ? b : a);
  return {
    chargeMode: pick(o.chargeMode, settings.chargeMode),
    onlineRatePaise: pick(o.onlineRatePaise, settings.onlineRatePaise),
    offlineRatePaise: pick(o.offlineRatePaise, settings.offlineRatePaise),
    percentBps: pick(o.percentBps, settings.percentBps),
    maxMonthlyChargePaise: pick(o.maxMonthlyChargePaise, settings.maxMonthlyChargePaise),
  };
};

/**
 * The charge for one token, before the monthly cap is applied.
 *
 * PERCENT bills a share of the consultation fee, which is only knowable when a
 * fee exists — a token booked before payment has none, so it falls back to the
 * flat rate rather than silently billing zero.
 */
export const computeAmountPaise = (rule, { source, consultationFeePaise = 0 }) => {
  const flat = channelOf(source) === 'ONLINE' ? rule.onlineRatePaise : rule.offlineRatePaise;
  if (rule.chargeMode === 'PERCENT' && consultationFeePaise > 0) {
    return Math.round((consultationFeePaise * rule.percentBps) / 10000);
  }
  // CUSTOM resolves to whatever the override put in the rate fields; with no
  // override it is identical to RUPEES. Both land here deliberately.
  return flat;
};

/**
 * Record a platform charge for a token.
 *
 * Idempotent on tokenId by a unique index, so a retry or a double-tap cannot
 * bill twice — a duplicate key is success, not an error.
 *
 * Returns null whenever nothing should be billed (still on trial, zero rate,
 * cap already reached). Callers do not need to know why.
 */
export const recordTokenCharge = async ({ hospital, token, consultationFee = 0 }) => {
  if (!hospital || !token) return null;
  if (!isBillable(hospital)) return null;

  const settings = await getBillingSettings();
  const rule = resolveRule(settings, hospital);
  const month = String(token.date || '').slice(0, 7);

  let amountPaise = computeAmountPaise(rule, {
    source: token.source,
    consultationFeePaise: paise(consultationFee),
  });
  if (amountPaise <= 0) return null;

  // The cap is a rail against a mis-set rate, so it is applied against what the
  // clinic has already accrued this month rather than trusting one row alone.
  let cappedBy = null;
  const cap = rule.maxMonthlyChargePaise;
  if (cap > 0) {
    const [agg] = await BillingCharge.aggregate([
      { $match: { hospitalId: hospital._id, month, status: { $ne: 'WAIVED' } } },
      { $group: { _id: null, total: { $sum: '$amountPaise' } } },
    ]);
    const already = agg?.total || 0;
    if (already >= cap) return null;
    if (already + amountPaise > cap) {
      amountPaise = cap - already;
      cappedBy = 'MONTHLY_CAP';
    }
  }

  try {
    return await BillingCharge.create({
      hospitalId: hospital._id,
      tokenId: token._id,
      doctorId: token.doctorId ?? null,
      date: token.date,
      month,
      source: token.source,
      channel: channelOf(token.source),
      amountPaise,
      chargeMode: rule.chargeMode,
      rateAppliedPaise: amountPaise,
      percentBpsApplied: rule.chargeMode === 'PERCENT' ? rule.percentBps : 0,
      cappedBy,
    });
  } catch (err) {
    // Duplicate key means this token was already billed. That is the idempotency
    // guarantee working, not a failure.
    if (err?.code === 11000) return null;
    throw err;
  }
};

/**
 * Fire-and-forget wrapper for the booking paths.
 *
 * Billing must never be the reason a patient cannot get a token, so this
 * swallows everything and logs. A missed charge is recoverable from the token
 * record later; a refused booking is not recoverable at all.
 */
export const recordTokenChargeSafe = async (args) => {
  try {
    return await recordTokenCharge(args);
  } catch (err) {
    logger.error({ err, tokenId: args?.token?._id }, 'billing: failed to record token charge');
    return null;
  }
};
