import { env } from '../config/env.js';
import { ageFrom } from '../lib/dates.js';
import { INDEMNITY_PLANS, TOPUP_PLANS, PLAN_TYPE } from '../config/constants.js';

/**
 * Health-insurance gap analysis.
 *
 * Four rules, each producing a scored Gap. Benchmarks are keyed off the
 * district's city tier because a Tier-1 metro room costs roughly three times a
 * Tier-3 one — a single national benchmark would be wrong almost everywhere.
 */

// Indian private-hospital reality. These age; benchmarkVersion records which
// set produced a stored analysis.
const BENCHMARKS = {
  1: { singleRoomDaily: 9000, recommendedSI: 1000000, icuDaily: 25000 },
  2: { singleRoomDaily: 6000, recommendedSI: 700000, icuDaily: 18000 },
  3: { singleRoomDaily: 3500, recommendedSI: 500000, icuDaily: 12000 },
};
const FAMILY_SI_MULTIPLIER = { 1: 1.0, 2: 1.5, 3: 2.0, 4: 2.5, 5: 3.0 };
const CRITICAL_ILLNESS_MIN_SI = 500000;

const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);

/**
 * A room-rent cap does not merely limit the room charge. Most Indian insurers
 * apply PROPORTIONATE DEDUCTION: if your cap is 1/3 of the actual room rate,
 * roughly 1/3 of the entire bill is paid — surgeon's fee, ICU and medicines
 * included. This is the least understood and highest-impact gap in the market.
 */
const effectiveRoomCap = (p) => {
  if (p.roomRentCapDaily == null && p.roomRentCapPct == null) return Infinity; // uncapped = ideal
  const fromPct = p.roomRentCapPct != null ? (p.sumInsured * p.roomRentCapPct) / 100 : Infinity;
  return Math.min(p.roomRentCapDaily ?? Infinity, fromPct);
};

export const analyzeGaps = ({ policies = [], district, patient }) => {
  const tier = district?.cityTier ?? 2;
  const bm = BENCHMARKS[tier] ?? BENCHMARKS[2];
  const districtName = district?.name ?? 'your city';
  const assumptions = [];
  const gaps = [];

  const active = policies.filter((p) => p.isActive !== false);

  if (active.length === 0) {
    gaps.push({
      code: 'ZERO_ACTIVE_POLICIES',
      severity: 'CRITICAL',
      score: 100,
      title: 'No active health insurance',
      detail: `A single cardiac procedure or a ten-day ICU stay in ${districtName} runs ₹4–8 lakh, payable entirely out of pocket today.`,
      remedy: `Start with a ₹5,00,000 family floater with no room-rent sub-limit.`,
      metrics: {},
    });
    return finalize({ gaps, active, bm, tier, districtName, assumptions, patient });
  }

  const indemnity = active.filter((p) => INDEMNITY_PLANS.includes(p.planType));
  const topUps = active.filter((p) => TOPUP_PLANS.includes(p.planType));

  // ---- Rule 1: room-rent cap (max 35 points) ----
  for (const p of indemnity) {
    const cap = effectiveRoomCap(p);
    if (cap >= bm.singleRoomDaily) continue;
    const shortfallPct = Math.round((1 - cap / bm.singleRoomDaily) * 100);
    gaps.push({
      code: 'ROOM_RENT_CAP_LOW',
      severity: shortfallPct >= 50 ? 'CRITICAL' : shortfallPct >= 25 ? 'HIGH' : 'MEDIUM',
      score: Math.min(35, Math.round(shortfallPct * 0.35)),
      policyId: String(p._id),
      title: 'Room rent limit is below local hospital rates',
      detail: `Your cap is ₹${fmt(cap)}/day on ${p.insurerName}, but a single room in ${districtName} averages ₹${fmt(bm.singleRoomDaily)}/day. Because most insurers apply proportionate deduction, roughly ${shortfallPct}% of your ENTIRE bill — surgeon, ICU, medicines — could be disallowed, not just the room charge.`,
      remedy: 'Move to a plan with no room-rent sub-limit, or add a rider that removes it.',
      metrics: { capDaily: cap === Infinity ? null : cap, benchmarkDaily: bm.singleRoomDaily, proportionateDeductionPct: shortfallPct },
    });
  }

  // ---- Rule 2: fragmentation (max 25 points) ----
  // Indemnity policies do not stack: a hospitalization claims against ONE base
  // policy. Three ₹2L policies buy ₹2L of protection while charging three premiums.
  const effectiveCover = indemnity.length ? Math.max(...indemnity.map((p) => p.sumInsured)) : 0;
  if (indemnity.length >= 2) {
    const nominalTotal = sum(indemnity.map((p) => p.sumInsured));
    const wastedCover = nominalTotal - effectiveCover;
    const totalPremium = sum(indemnity.map((p) => p.premiumAnnual));
    const wastedPct = Math.round((wastedCover / nominalTotal) * 100);
    gaps.push({
      code: 'FRAGMENTED_COVER',
      severity: indemnity.length >= 3 ? 'HIGH' : 'MEDIUM',
      score: Math.min(25, 8 * (indemnity.length - 1) + Math.round(wastedPct * 0.12)),
      title: `${indemnity.length} separate health policies`,
      detail: `You hold ₹${fmt(nominalTotal)} of cover on paper across ${indemnity.length} policies, but a single hospitalization can realistically draw on about ₹${fmt(effectiveCover)} — the largest one. ₹${fmt(wastedCover)} (${wastedPct}%) is duplicated cover${totalPremium ? `, and you pay ₹${fmt(totalPremium)}/yr for it` : ''}.`,
      remedy: 'Consolidate into one base policy plus a super top-up. A super top-up aggregates claims across the year against a single deductible, so it genuinely stacks.',
      metrics: { policyCount: indemnity.length, nominalTotal, effectiveCover, wastedCover, totalPremium },
    });
  }

  // ---- Rule 3: missing critical illness (6-20 points by age) ----
  const hasCI = active.some(
    (p) => p.planType === PLAN_TYPE.CRITICAL_ILLNESS || (p.riders || []).includes('CRITICAL_ILLNESS'),
  );
  const age = ageFrom(patient?.dob);
  if (age == null) assumptions.push('Patient date of birth unknown; assumed age 35');
  const effAge = age ?? 35;
  if (!hasCI) {
    gaps.push({
      code: 'NO_CRITICAL_ILLNESS',
      severity: effAge >= 40 ? 'HIGH' : effAge >= 30 ? 'MEDIUM' : 'LOW',
      score: effAge >= 40 ? 20 : effAge >= 30 ? 12 : 6,
      title: 'No critical illness cover',
      detail: 'Indemnity health insurance reimburses hospital bills only. A cancer, stroke or cardiac diagnosis also brings months of lost income, home care and non-hospital treatment that no indemnity plan pays for. A critical illness plan pays a lump sum on diagnosis, regardless of bills.',
      remedy: `Add a critical illness rider or standalone plan of at least ₹${fmt(CRITICAL_ILLNESS_MIN_SI)}.`,
      metrics: { patientAge: effAge, recommendedCiSi: CRITICAL_ILLNESS_MIN_SI },
    });
  }

  // ---- Rule 4: sum-insured adequacy (max 30 points) ----
  // Top-ups DO add here — unlike indemnity, they stack above a deductible.
  const memberCount = Math.max(
    1,
    new Set(active.flatMap((p) => (p.membersCovered || []).map((m) => m.name))).size || (patient?.familyMembers?.length ?? 1),
  );
  const multiplier = FAMILY_SI_MULTIPLIER[Math.min(memberCount, 5)] ?? 3.0;
  const recommended = Math.round((bm.recommendedSI * multiplier) / 100000) * 100000;
  const effective = effectiveCover + sum(topUps.map((t) => t.sumInsured));
  if (effective < recommended) {
    const shortfall = recommended - effective;
    const shortfallPct = Math.round((shortfall / recommended) * 100);
    gaps.push({
      code: 'SUM_INSURED_LOW',
      severity: shortfallPct >= 60 ? 'CRITICAL' : shortfallPct >= 35 ? 'HIGH' : 'MEDIUM',
      score: Math.min(30, Math.round(shortfallPct * 0.3)),
      title: 'Sum insured below the recommended level',
      detail: `For a family of ${memberCount} in a Tier-${tier} city, ₹${fmt(recommended)} is the recommended cover. You have ₹${fmt(effective)} — a ₹${fmt(shortfall)} shortfall. A single cardiac bypass or ten-day ICU stay in ${districtName} runs ₹4–8 lakh.`,
      remedy: `A super top-up of ₹${fmt(shortfall)} above a ₹${fmt(effective)} deductible typically costs a fraction of raising the base sum insured.`,
      metrics: { effective, recommended, shortfall, memberCount, cityTier: tier },
    });
  }

  // Co-pay is a sub-note, not a standalone gap: a 20% copay quietly converts a
  // ₹5L cover into ₹4L of real protection.
  for (const p of active.filter((x) => x.copayPct > 0)) {
    gaps.push({
      code: 'COPAY_PRESENT',
      severity: p.copayPct >= 20 ? 'MEDIUM' : 'LOW',
      score: Math.min(8, Math.round(p.copayPct * 0.25)),
      policyId: String(p._id),
      title: `${p.copayPct}% co-payment on ${p.insurerName}`,
      detail: `You pay ${p.copayPct}% of every admitted claim yourself. On a ₹5,00,000 claim that is ₹${fmt(500000 * (p.copayPct / 100))} out of pocket, so the effective protection is lower than the sum insured suggests.`,
      remedy: 'Prefer a zero-copay plan, or budget for the co-payment share.',
      metrics: { copayPct: p.copayPct },
    });
  }

  return finalize({ gaps, active, bm, tier, districtName, assumptions, patient, indemnity, topUps, effectiveCover, hasCI, memberCount });
};

const finalize = ({ gaps, active, bm, tier, districtName, assumptions, indemnity = [], topUps = [], effectiveCover = 0, hasCI = false, memberCount = 1 }) => {
  const rawScore = sum(gaps.map((g) => g.score));
  const gapScore = Math.min(100, rawScore);
  const protectionScore = 100 - gapScore;
  const grade =
    protectionScore >= 80 ? 'A' : protectionScore >= 65 ? 'B' : protectionScore >= 45 ? 'C' : protectionScore >= 25 ? 'D' : 'F';

  const multiplier = FAMILY_SI_MULTIPLIER[Math.min(memberCount, 5)] ?? 3.0;
  const recommended = Math.round((bm.recommendedSI * multiplier) / 100000) * 100000;
  const base = 500000; // covers ~85% of claims by frequency
  const effective = effectiveCover + sum(topUps.map((t) => t.sumInsured));

  const recommendation = active.length
    ? {
        structure: 'BASE_PLUS_SUPER_TOPUP',
        baseSumInsured: base,
        superTopUp: recommended > base ? { sumInsured: recommended - base, deductible: base } : null,
        roomRentCap: null, // explicitly: no cap
        criticalIllness: hasCI ? null : { sumInsured: CRITICAL_ILLNESS_MIN_SI },
        replaces: indemnity.map((p) => ({
          policyId: String(p._id),
          insurerName: p.insurerName,
          policyNumber: p.policyNumber,
          sumInsured: p.sumInsured,
          premiumAnnual: p.premiumAnnual ?? null,
        })),
        rationale: gaps.map((g) => g.title),
        estimatedPremiumRange: { min: Math.round(recommended * 0.014), max: Math.round(recommended * 0.026) },
        premiumNote: 'Indicative only — actual premium depends on age, city and medical history.',
      }
    : null;

  return {
    protectionScore,
    gapScore,
    grade,
    summary: {
      policyCount: active.length,
      effectiveCover: effective,
      recommendedCover: recommended,
      nominalCover: sum(active.map((p) => p.sumInsured)),
    },
    gaps: gaps.sort((a, b) => b.score - a.score),
    recommendation,
    meta: {
      cityTier: tier,
      district: districtName,
      assumptions,
      benchmarkVersion: env.POLICY_BENCHMARK_VERSION,
      generatedAt: new Date().toISOString(),
    },
  };
};
