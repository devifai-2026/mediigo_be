import mongoose from 'mongoose';
import {
  Transaction, OPDToken, Hospital, Doctor, PettyExpense, Prescription, User,
} from '../../models/index.js';
import { clinicDate } from '../../lib/dates.js';
import { notFound, conflict, validationError } from '../../lib/errors.js';
import { assertHospitalScope } from '../../middleware/rbac.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { AUDIT_ACTIONS, ROLES } from '../../config/constants.js';

/**
 * The desk's books beyond the day close: petty cash, the itemised ledger and
 * the footfall register.
 *
 * A doctor sees their own patients and money only; the front desk sees the
 * whole clinic. That rule lives in `scopeFor`, so no endpoint can forget it.
 */

const shiftDays = (isoDate, delta) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

/**
 * Which doctor a desk report covers. A doctor sees their own numbers — unless
 * they are the clinic's admin doctor, who sees the whole clinic (or picks one
 * doctor in it). Everyone else picks freely within their clinic.
 */
export const reportDoctorId = async (actor, requestedDoctorId = null) => {
  if (actor.role !== ROLES.DOCTOR) return requestedDoctorId || null;
  const me = await Doctor.findById(actor.doctorId).select('isClinicAdmin').lean();
  return me?.isClinicAdmin ? (requestedDoctorId || null) : actor.doctorId;
};

export const scopeFor = async (actor, requested = {}) => {
  const hospitalId = actor.hospitalId || requested.hospitalId;
  const hospital = hospitalId ? await Hospital.findById(hospitalId).lean() : null;
  if (!hospital) throw notFound('Clinic not found');
  assertHospitalScope(actor, hospital);
  const doctorId = await reportDoctorId(actor, requested.doctorId);
  return { hospital, doctorId };
};

const PERIOD_SPAN = { day: 1, week: 7, month: 30, '6month': 182, year: 365 };
const MAX_RANGE_DAYS = 366;

const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;

/**
 * The [from, to] window a desk report covers, clinic-local 'YYYY-MM-DD'.
 *
 * An explicit range wins, then a single date, then a named period ending
 * today. A range reaching past today is cut at today — the future has no
 * takings — and anything over a year is refused rather than silently
 * scanning the clinic's whole history.
 */
export const resolveRange = (hospital, { period, date, from, to } = {}) => {
  const today = clinicDate(hospital?.timezone);
  let lo;
  let hi;
  if (from || to) {
    lo = from || to;
    hi = to || from;
  } else if (date) {
    lo = date;
    hi = date;
  } else {
    hi = today;
    lo = shiftDays(today, -((PERIOD_SPAN[period] || 1) - 1));
  }
  if (lo > hi) throw validationError([{ path: 'from', message: 'Start date is after the end date' }]);
  if (hi > today) hi = today;
  if (lo > today) throw validationError([{ path: 'from', message: 'That date has not happened yet' }]);
  const days = daysBetween(lo, hi);
  if (days > MAX_RANGE_DAYS) {
    throw validationError([{ path: 'to', message: `Pick a range of up to ${MAX_RANGE_DAYS} days` }]);
  }
  return { from: lo, to: hi, days, today };
};

/** Kept for callers that only know a period and an end date. */
export const windowFor = (hospital, query = {}) => resolveRange(hospital, query);

// ---- Petty cash -------------------------------------------------------------

export const logExpense = async ({ body, actor }) => {
  const { hospital } = await scopeFor(actor);
  const expense = await PettyExpense.create({
    hospitalId: hospital._id,
    date: clinicDate(hospital.timezone),
    amount: body.amount,
    category: body.category,
    note: body.note || '',
    createdBy: actor.id,
  });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PETTY_EXPENSE_LOGGED,
    entityType: 'PettyExpense', entityId: expense._id,
    hospitalId: hospital._id, districtId: hospital.districtId,
    after: { amount: expense.amount, category: expense.category },
  });
  return expense.toObject();
};

/**
 * Void, never delete: the drawer was short by this amount at the time, and the
 * ledger must still show that it was recorded and then reversed.
 */
export const voidExpense = async ({ id, reason, actor }) => {
  const { hospital } = await scopeFor(actor);
  const expense = await PettyExpense.findOne({ _id: id, hospitalId: hospital._id });
  if (!expense) throw notFound('Expense not found');
  if (expense.status === 'VOID') throw conflict('This expense is already void');
  expense.status = 'VOID';
  expense.void = { reason: reason || '', at: new Date(), byUserId: actor.id };
  await expense.save();
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PETTY_EXPENSE_VOIDED,
    entityType: 'PettyExpense', entityId: expense._id,
    hospitalId: hospital._id, districtId: hospital.districtId,
    before: { amount: expense.amount, category: expense.category }, after: { reason },
  });
  return expense.toObject();
};

export const expenseTotal = async (hospitalId, from, to) => {
  const r = await PettyExpense.aggregate([
    { $match: { hospitalId: new mongoose.Types.ObjectId(String(hospitalId)), date: { $gte: from, $lte: to }, status: 'ACTIVE' } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return { total: r[0]?.total ?? 0, count: r[0]?.count ?? 0 };
};

// ---- Ledger -----------------------------------------------------------------

const methodOf = (tender = {}) => {
  const used = ['cash', 'upi', 'card'].filter((k) => (tender[k] ?? 0) > 0);
  if (used.length > 1) return 'SPLIT';
  return used[0]?.toUpperCase() ?? 'FREE';
};

/**
 * Every receipt and petty expense in the window, newest first. A doctor's
 * ledger has no petty cash in it: the drawer is the desk's, not theirs.
 */
export const ledger = async ({ actor, query }) => {
  const { hospital, doctorId } = await scopeFor(actor, query);
  const { from, to } = windowFor(hospital, query);

  const txFilter = { hospitalId: hospital._id, date: { $gte: from, $lte: to } };
  if (doctorId) txFilter.doctorId = doctorId;

  const [txns, expenses, doctors] = await Promise.all([
    Transaction.find(txFilter).sort({ createdAt: -1 }).limit(500).lean(),
    doctorId ? [] : PettyExpense.find({ hospitalId: hospital._id, date: { $gte: from, $lte: to } }).sort({ createdAt: -1 }).lean(),
    Doctor.find({ hospitalId: hospital._id }).select('name chamberNumber specialty').lean(),
  ]);
  const tokens = await OPDToken.find({ _id: { $in: txns.map((t) => t.tokenId) } })
    .select('tokenNumber patientSnapshot.name status').lean();
  const tokenById = new Map(tokens.map((t) => [String(t._id), t]));
  const docById = new Map(doctors.map((d) => [String(d._id), d]));
  const people = await User.find({ _id: { $in: [...expenses.map((e) => e.createdBy), ...txns.map((t) => t.collectedBy)] } })
    .select('name').lean();
  const nameOf = new Map(people.map((p) => [String(p._id), p.name]));

  const items = [
    ...txns.map((t) => {
      const tok = tokenById.get(String(t.tokenId));
      const doc = docById.get(String(t.doctorId));
      return {
        id: String(t._id),
        kind: 'RECEIPT',
        at: t.createdAt,
        date: t.date,
        receiptNumber: t.receiptNumber,
        tokenNumber: tok?.tokenNumber ?? null,
        patientName: tok?.patientSnapshot?.name || '',
        doctorId: String(t.doctorId),
        doctorName: doc?.name || '',
        chamberNumber: doc?.chamberNumber || '',
        visitType: t.visitType || 'fresh',
        method: methodOf(t.tender),
        tender: t.tender,
        amount: t.status === 'PAID' ? t.totalFee : 0,
        originalAmount: t.totalFee,
        status: t.status,
        by: nameOf.get(String(t.collectedBy)) || '',
      };
    }),
    ...expenses.map((e) => ({
      id: String(e._id),
      kind: 'EXPENSE',
      at: e.createdAt,
      date: e.date,
      category: e.category,
      note: e.note,
      method: 'CASH',
      amount: e.status === 'ACTIVE' ? -e.amount : 0,
      originalAmount: e.amount,
      status: e.status,
      voidReason: e.void?.reason || '',
      by: nameOf.get(String(e.createdBy)) || '',
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  return { from, to, doctorId, items };
};

// ---- Footfall register ------------------------------------------------------

/**
 * Who came in on one day, when, to whom, and what they were prescribed.
 * The prescribed medicines are the doctor's record; the desk sees names and
 * dosages only so it can answer a patient at the counter.
 */
export const footfall = async ({ actor, query }) => {
  const { hospital, doctorId } = await scopeFor(actor, query);
  // Today unless asked otherwise; a register defaults to the day at hand.
  const { from, to } = resolveRange(hospital, { period: 'day', ...query });

  const filter = { hospitalId: hospital._id, date: from === to ? from : { $gte: from, $lte: to } };
  if (doctorId) filter.doctorId = doctorId;

  const [tokens, doctors] = await Promise.all([
    OPDToken.find(filter)
      .select('tokenNumber status visitType source patientSnapshot doctorId createdAt enteredChamberAt completedAt shift date')
      .sort({ date: 1, createdAt: 1 }).limit(2000).lean(),
    Doctor.find({ hospitalId: hospital._id }).select('name chamberNumber specialty').lean(),
  ]);
  // Visits are the clinic's footfall; what was prescribed is the treating
  // doctor's record. A clinic-admin doctor sees every visit, but only their
  // own patients' prescriptions.
  const rx = await Prescription.find({
    tokenId: { $in: tokens.map((t) => t._id) },
    ...(actor.role === ROLES.DOCTOR ? { doctorId: actor.doctorId } : {}),
  }).sort({ createdAt: -1 }).lean();
  const rxByToken = new Map();
  for (const r of rx) {
    const k = String(r.tokenId);
    if (!rxByToken.has(k)) rxByToken.set(k, []);
    // The whole record, so the register can show the prescription in place.
    rxByToken.get(k).push({ ...r, id: String(r._id), at: r.createdAt });
  }
  const docById = new Map(doctors.map((d) => [String(d._id), d]));

  return {
    from,
    to,
    date: to,
    doctorId,
    truncated: tokens.length === 2000,
    rows: tokens.map((t) => ({
      tokenId: String(t._id),
      date: t.date,
      tokenNumber: t.tokenNumber,
      status: t.status,
      visitType: t.visitType || 'fresh',
      source: t.source,
      checkInAt: t.createdAt,
      enteredChamberAt: t.enteredChamberAt ?? null,
      completedAt: t.completedAt ?? null,
      patientName: t.patientSnapshot?.name || '',
      phone: t.patientSnapshot?.phone || '',
      age: t.patientSnapshot?.age ?? null,
      gender: t.patientSnapshot?.gender ?? null,
      complaint: t.patientSnapshot?.complaint || '',
      doctorId: String(t.doctorId),
      doctorName: docById.get(String(t.doctorId))?.name || '',
      prescriptions: rxByToken.get(String(t._id)) || [],
    })),
  };
};
