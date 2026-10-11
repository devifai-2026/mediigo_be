/**
 * Edge-case demo data for the OPD Desk, Analytics, Super Admin and Field
 * Agent features. Run AFTER the base seed:
 *
 *   npm run seed && npm run seed:edge
 *
 * Re-runnable: everything this script creates is recorded in a
 * `seed_manifest` document and removed before it seeds again, so running it
 * twice gives the same data, not double. It never deletes anything it did not
 * create — with one deliberate exception: it (re)sets doctors' weekly
 * schedules, booking/break state and ratings, which it needs for the roster
 * and live-monitor cases.
 *
 * What each case is for is listed in the summary printed at the end.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/modules/auth/service.js';
import { clinicDate, financialYear } from '../src/lib/dates.js';
import { formatReceipt, tokenCounterId, receiptCounterId } from '../src/lib/counters.js';
import {
  User, District, Hospital, Doctor, OPDToken, Transaction, Counter,
  Prescription, PettyExpense, ClinicLead, OnboardingSubmission,
} from '../src/models/index.js';
import { ROLES, TOKEN_STATUS, TOKEN_SOURCE, SUBMISSION_STATUS } from '../src/config/constants.js';

const FORCE = process.argv.includes('--force');
const PASSWORD = 'Mediigo@123';
const TZ = env.DEFAULT_TIMEZONE;
const MANIFEST_ID = 'edge-cases';
const PATIENT_PREFIX = '970000';

// ---- time helpers (clinic-local) -------------------------------------------

const dayStr = (offset = 0) => clinicDate(TZ, new Date(Date.now() + offset * 86400000));
const DOW = (offset = 0) => new Date(`${dayStr(offset)}T00:00:00Z`).getUTCDay();
/** A Date at hh:mm clinic time on the day `offset` days from today (IST, +05:30). */
const at = (offset, hh, mm = 0) => {
  const [y, m, d] = dayStr(offset).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60000);
};
const minsAgo = (n) => new Date(Date.now() - n * 60000);
const hoursAgo = (n) => new Date(Date.now() - n * 3600000);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n, hh = 11) => at(n, hh);

// Deterministic "random" so every run gives the same shape.
let seed = 42;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---- manifest ---------------------------------------------------------------

const created = {};
const track = (model, doc) => {
  (created[model.modelName] ||= []).push(doc._id);
  return doc;
};

const cleanPrevious = async (db) => {
  const manifest = await db.collection('seed_manifest').findOne({ _id: MANIFEST_ID });
  const models = { ClinicLead, OnboardingSubmission, PettyExpense, Prescription, Transaction, OPDToken, User };
  if (manifest?.ids) {
    for (const [name, ids] of Object.entries(manifest.ids)) {
      if (models[name] && ids?.length) await models[name].deleteMany({ _id: { $in: ids } });
    }
  }
  // Belt and braces: anything attached to the seed's patients goes too, even
  // if the manifest was lost (tokens they booked, receipts, prescriptions).
  const patients = await User.find({ phone: new RegExp(`^${PATIENT_PREFIX}`) }).select('_id').lean();
  if (patients.length) {
    const pids = patients.map((p) => p._id);
    const toks = await OPDToken.find({ patientId: { $in: pids } }).select('_id').lean();
    const tids = toks.map((t) => t._id);
    await Promise.all([
      Transaction.deleteMany({ tokenId: { $in: tids } }),
      Prescription.deleteMany({ tokenId: { $in: tids } }),
    ]);
    await OPDToken.deleteMany({ _id: { $in: tids } });
  }
};

// ---- builders ---------------------------------------------------------------

const ctx = {};

const nextReceipt = async (hospital, date) => {
  const fy = financialYear(date);
  const c = await Counter.findOneAndUpdate({ _id: receiptCounterId(hospital._id, fy) }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return { seq: c.seq, fy, number: formatReceipt(env.RECEIPT_PREFIX, hospital.code, fy, c.seq) };
};

const tokenNumbers = new Map();
const nextToken = async (doctor, date, shift = 'MORNING') => {
  const key = `${doctor._id}:${date}:${shift}`;
  if (!tokenNumbers.has(key)) {
    const top = await OPDToken.findOne({ doctorId: doctor._id, date, shift }).sort({ tokenNumber: -1 }).select('tokenNumber').lean();
    tokenNumbers.set(key, top?.tokenNumber ?? 0);
  }
  const n = tokenNumbers.get(key) + 1;
  tokenNumbers.set(key, n);
  return n;
};

/**
 * One visit: a token, and (unless unbilled) its receipt. `pay` is a tender
 * {cash, upi, card}; omit for a fully-cash payment of the listed fee.
 */
const visit = async ({
  doctor, hospital, patient, offset = 0, status = TOKEN_STATUS.COMPLETED, visitType = 'fresh',
  checkIn, chamberAt, doneAt, pay, discount = 0, unbilled = false, refunded = false,
  complaint, conditions = [], outcome = null, skipReason, followUp, shift = 'MORNING', source = TOKEN_SOURCE.WALKIN,
  collector,
}) => {
  const date = dayStr(offset);
  const tokenNumber = await nextToken(doctor, date, shift);
  const created_ = checkIn || at(offset, 10, Math.floor(rand() * 50));
  const token = track(OPDToken, await OPDToken.create({
    tokenNumber, date, shift, doctorId: doctor._id, hospitalId: hospital._id, patientId: patient._id,
    patientSnapshot: {
      name: patient.name, phone: patient.phone?.startsWith('NOPHONE') ? undefined : patient.phone,
      age: patient.age, gender: patient.gender, complaint, conditions,
    },
    visitType, source, status,
    statusHistory: [{ from: null, to: status, at: created_ }],
    enteredChamberAt: chamberAt ?? (status === TOKEN_STATUS.COMPLETED ? new Date(created_.getTime() + 20 * 60000) : undefined),
    completedAt: doneAt ?? (status === TOKEN_STATUS.COMPLETED ? new Date(created_.getTime() + (28 + rand() * 10) * 60000) : undefined),
    skippedAt: status === TOKEN_STATUS.SKIPPED ? created_ : undefined,
    skipReason,
    outcome: status === TOKEN_STATUS.COMPLETED ? (outcome || 'DONE') : null,
    cancelledAt: status === TOKEN_STATUS.CANCELLED ? created_ : undefined,
    cancelReason: status === TOKEN_STATUS.CANCELLED ? 'Patient cancelled from the app' : undefined,
    followUp: followUp || undefined,
    isPaid: !unbilled,
  }));
  // Mongoose stamps createdAt itself; the footfall register reads check-in
  // time from it, so put it where the visit actually happened.
  await OPDToken.collection.updateOne({ _id: token._id }, { $set: { createdAt: created_ } });

  if (unbilled) return token;
  const base = doctor.fees[visitType];
  const total = Math.max(0, base - discount);
  const tender = pay || { cash: total, upi: 0, card: 0 };
  const r = await nextReceipt(hospital, date);
  const txn = track(Transaction, await Transaction.create({
    tokenId: token._id, hospitalId: hospital._id, doctorId: doctor._id, patientId: patient._id, date,
    visitType, baseFee: base, discount, totalFee: total, tender: { cash: 0, upi: 0, card: 0, ...tender },
    receiptNumber: r.number, receiptSeq: r.seq, fy: r.fy,
    collectedBy: collector?._id ?? ctx.receptionist._id,
    status: refunded ? 'REFUNDED' : 'PAID',
    refund: refunded ? { amount: total, reason: 'Doctor left early — consultation not given', at: created_, byUserId: ctx.receptionist._id } : undefined,
  }));
  await Transaction.collection.updateOne({ _id: txn._id }, { $set: { createdAt: created_ } });
  await OPDToken.updateOne({ _id: token._id }, { $set: { transactionId: txn._id } });
  return token;
};

const rx = async (token, doctor, patient, { diagnosis, medicines, advice = '', reviewDate = null, when }) => {
  const doc = track(Prescription, await Prescription.create({
    hospitalId: token.hospitalId, doctorId: doctor._id, patientId: patient._id, tokenId: token._id,
    tokenNumber: token.tokenNumber, date: token.date,
    patientSnapshot: { name: patient.name, phone: patient.phone, age: patient.age, gender: patient.gender },
    doctorSnapshot: { name: doctor.name, specialty: doctor.specialty, chamberNumber: doctor.chamberNumber, qualifications: doctor.qualifications },
    diagnosis, medicines, advice, reviewDate, createdBy: doctor.userId,
  }));
  if (when) await Prescription.collection.updateOne({ _id: doc._id }, { $set: { createdAt: when } });
  return doc;
};

const petty = async (hospital, offset, amount, category, { note = '', voided, by } = {}) => {
  const e = track(PettyExpense, await PettyExpense.create({
    hospitalId: hospital._id, date: dayStr(offset), amount, category, note,
    createdBy: (by || ctx.receptionist)._id,
    status: voided ? 'VOID' : 'ACTIVE',
    void: voided ? { reason: voided, at: at(offset, 18), byUserId: ctx.receptionist._id } : undefined,
  }));
  await PettyExpense.collection.updateOne({ _id: e._id }, { $set: { createdAt: at(offset, 9 + Math.floor(rand() * 9), 15) } });
  return e;
};

const patientUser = async (i, name, { age, gender, phone } = {}) => {
  const p = `${PATIENT_PREFIX}${String(i).padStart(4, '0')}`;
  const u = await User.findOneAndUpdate(
    { phone: p },
    { $set: { name, role: ROLES.PATIENT, gender } },
    { new: true, upsert: true },
  ).lean();
  return { ...u, age, gender, phone: phone === null ? `NOPHONE-${p}` : p };
};

// ---- the cases --------------------------------------------------------------

const run = async () => {
  if (env.NODE_ENV === 'production' && !FORCE) {
    logger.error('Refusing to seed demo data in production without --force');
    process.exit(1);
  }
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  const db = mongoose.connection.db;

  const need = async (Model, filter, what) => {
    const d = await Model.findOne(filter).lean();
    if (!d) {
      logger.error(`${what} not found — run the base seed first: npm run seed`);
      process.exit(1);
    }
    return d;
  };
  const h1 = await need(Hospital, { code: 'MG-KOL-001' }, 'Sunrise Multispeciality');
  const h2 = await need(Hospital, { code: 'MG-KOL-002' }, 'CareWell Polyclinic');
  const kol = await need(District, { code: 'WB-KOL' }, 'Kolkata district');
  const how = await need(District, { code: 'WB-HOW' }, 'Howrah district');
  const [sandeep, ananya, vikram, priya, sunita, kavita] = await Promise.all(
    ['WBMC-55101', 'WBMC-55102', 'WBMC-55103', 'WBMC-55104', 'WBMC-55105', 'WBMC-55106']
      .map((reg) => need(Doctor, { councilRegNo: reg }, `Doctor ${reg}`)),
  );
  ctx.receptionist = await need(User, { phone: '9000000031' }, 'Receptionist Riya Sen');
  const receptionist2 = await need(User, { phone: '9000000032' }, 'Receptionist Arjun Ghosh');
  const execKol = await need(User, { phone: '9000000011' }, 'Kolkata district admin');
  const suresh = await need(User, { phone: '9000000021' }, 'Field agent Suresh Kumar');
  const meera = await need(User, { phone: '9000000022' }, 'Field agent Meera Iyer');

  await cleanPrevious(db);
  logger.info('previous edge-case data removed — seeding');

  // ---- Patients ----
  const P = {
    long: await patientUser(1, 'Shrimati Annapurna Venkataraghavan Subramaniam-Chattopadhyay', { age: 67, gender: 'F' }),
    chronic: await patientUser(2, 'Biswajit Mukherjee', { age: 58, gender: 'M' }),
    emergency: await patientUser(3, 'Tanvir Ahmed', { age: 41, gender: 'M' }),
    minimal: await patientUser(4, 'Walk-in Patient', { phone: null }),
    child: await patientUser(5, 'Ishaan Ghosh', { age: 2, gender: 'M' }),
    senior: await patientUser(6, 'Kamala Devi', { age: 94, gender: 'F' }),
    regular: await patientUser(7, 'Rohit Sharma', { age: 33, gender: 'M' }),
    followup: await patientUser(8, 'Meghna Paul', { age: 29, gender: 'F' }),
    split: await patientUser(9, 'Arnab Bose', { age: 45, gender: 'M' }),
    free: await patientUser(10, 'Sister Mary (staff)', { age: 50, gender: 'F' }),
  };
  const crowd = [];
  for (let i = 0; i < 40; i += 1) {
    crowd.push(await patientUser(100 + i, pick(['Ankit', 'Puja', 'Sourav', 'Riya', 'Debasish', 'Moumita', 'Arijit', 'Sneha', 'Kunal', 'Tania']) + ' ' + pick(['Das', 'Saha', 'Roy', 'Paul', 'Dutta', 'Ghosh', 'Sen', 'Pal']), {
      age: 5 + Math.floor(rand() * 75), gender: rand() > 0.5 ? 'M' : 'F',
    }));
  }

  // ---- Doctor state for the roster & live monitor ----
  const today = dayStr(0);
  await Doctor.updateOne({ _id: sandeep._id }, {
    $set: {
      schedule: [
        { day: DOW(0), shift: 'MORNING', startTime: '09:00', endTime: '14:00', maxTokens: 25, isActive: true },
        { day: DOW(0), shift: 'EVENING', startTime: '17:00', endTime: '21:00', isActive: true },
      ],
      'rating.average': 4.6, 'rating.count': 23,
      'session.isBookingOpen': true, 'session.isOnBreak': false,
    },
  });
  // Full sitting: capacity reached.
  await Doctor.updateOne({ _id: ananya._id }, {
    $set: {
      schedule: [{ day: DOW(0), shift: 'MORNING', startTime: '10:00', endTime: '13:00', maxTokens: 10, isActive: true }],
      'rating.average': 4.9, 'rating.count': 112,
      'session.isBookingOpen': true, 'session.isOnBreak': false,
    },
  });
  // A long queue with nobody in the chamber.
  await Doctor.updateOne({ _id: priya._id }, {
    $set: {
      schedule: [{ day: DOW(0), shift: 'MORNING', startTime: '08:00', endTime: '20:00', maxTokens: 40, isActive: true }],
      'session.isBookingOpen': true, 'session.isOnBreak': false,
    },
  });
  // On leave today, with a reason.
  await Doctor.updateOne({ _id: sunita._id }, {
    $set: {
      schedule: [{ day: DOW(0), shift: 'MORNING', startTime: '10:00', endTime: '14:00', isActive: true }],
      scheduleOverrides: [{ date: today, kind: 'off', shift: null, reason: 'Medical conference' }],
      'session.isBookingOpen': true, 'session.isOnBreak': false,
    },
  });
  // On a break that has overrun.
  await Doctor.updateOne({ _id: vikram._id }, {
    $set: {
      'session.isOnBreak': true, 'session.breakReason': 'Ward Round',
      'session.breakUntil': minsAgo(20), 'session.isBookingOpen': false,
    },
  });
  // Closed, no schedule at all.
  await Doctor.updateOne({ _id: kavita._id }, { $set: { schedule: [], 'session.isBookingOpen': false, 'session.isOnBreak': false } });

  // ---- TODAY: Dr. Ananya Roy (Sunrise) — every token state ----
  const A = { doctor: ananya, hospital: h1 };
  const a1 = await visit({ ...A, patient: P.chronic, status: TOKEN_STATUS.COMPLETED, outcome: 'TESTS', checkIn: at(0, 9, 40),
    complaint: 'Chest tightness on exertion', conditions: ['Diabetes', 'Hypertension', 'High cholesterol'] });
  await visit({ ...A, patient: P.senior, status: TOKEN_STATUS.COMPLETED, outcome: 'ADMITTED', checkIn: at(0, 9, 50),
    complaint: 'Breathlessness, swollen ankles', conditions: ['Heart failure', 'CKD stage 3'], pay: { cash: 0, upi: 0, card: 600 } });
  // In the chamber for 95 minutes — the timer must roll over to h:mm:ss.
  const aLong = await visit({ ...A, patient: P.long, status: TOKEN_STATUS.IN_CHAMBER, checkIn: hoursAgo(2), chamberAt: minsAgo(95),
    complaint: 'Recurring palpitations with dizziness for three weeks, worse at night, family history of arrhythmia, previously on beta blockers which were stopped by another doctor',
    conditions: ['Asthma', 'Thyroid', 'Diabetes', 'Hypertension', 'Penicillin allergy'] });
  // Emergency waiting: red row, pulsing badge, live-monitor alert.
  await visit({ ...A, patient: P.emergency, status: TOKEN_STATUS.WAITING, visitType: 'emergency', checkIn: minsAgo(12),
    complaint: 'Severe chest pain radiating to left arm', pay: { cash: 0, upi: 1200, card: 0 } });
  // Missing patient details: no phone, age or gender.
  await visit({ ...A, patient: P.minimal, status: TOKEN_STATUS.WAITING, checkIn: minsAgo(30), unbilled: true });
  // Split tender, and a free (fully discounted) staff consultation.
  await visit({ ...A, patient: P.split, status: TOKEN_STATUS.WAITING, checkIn: minsAgo(25), pay: { cash: 200, upi: 300, card: 100 }, complaint: 'Follow-up ECG review' });
  await visit({ ...A, patient: P.free, status: TOKEN_STATUS.WAITING, checkIn: minsAgo(20), discount: 600, pay: { cash: 0, upi: 0, card: 0 }, complaint: 'Staff health check' });
  // A doctor-booked follow-up the patient has not confirmed, past its deadline: "Release".
  await visit({ ...A, patient: P.followup, status: TOKEN_STATUS.WAITING, visitType: 'followup', checkIn: at(0, 9, 0),
    complaint: 'Review blood reports', followUp: { status: 'PENDING', respondBy: hoursAgo(3), note: 'Review lipid profile', scheduledAt: daysAgo(6) } });
  await visit({ ...A, patient: P.regular, status: TOKEN_STATUS.SKIPPED, checkIn: at(0, 10, 5), skipReason: 'Did not answer two calls' });
  await visit({ ...A, patient: crowd[0], status: TOKEN_STATUS.CANCELLED, checkIn: at(0, 8, 30), source: TOKEN_SOURCE.APP });
  // Refunded receipt: shows struck through in the ledger.
  await visit({ ...A, patient: crowd[1], status: TOKEN_STATUS.SKIPPED, checkIn: at(0, 10, 20), refunded: true, skipReason: 'Left before being called' });
  await Doctor.updateOne({ _id: ananya._id }, { $set: { 'session.lastCalledToken': aLong.tokenNumber } });

  // Prescriptions: a long pad, and a patient with an EMR history across visits.
  await rx(a1, ananya, P.chronic, {
    diagnosis: 'Stable angina — rule out coronary artery disease',
    medicines: [
      { name: 'Tab Ecosprin 75mg', dosage: '0-1-0', duration: 'Continue', instruction: 'After lunch' },
      { name: 'Tab Atorvastatin 40mg', dosage: '0-0-1', duration: 'Continue', instruction: 'At bedtime' },
      { name: 'Tab Metoprolol 25mg', dosage: '1-0-1', duration: '30 Days', instruction: 'After food' },
      { name: 'Tab Sorbitrate 5mg', dosage: 'SOS', duration: '30 Days', instruction: 'Under the tongue for chest pain' },
      { name: 'Tab Metformin 500mg', dosage: '1-0-1', duration: 'Continue', instruction: 'After food' },
      { name: 'Tab Telmisartan 40mg', dosage: '1-0-0', duration: 'Continue', instruction: 'Morning' },
      { name: 'Tab Pantoprazole 40mg', dosage: '1-0-0', duration: '14 Days', instruction: 'Before breakfast' },
      { name: 'Cap Vitamin D3 60K', dosage: 'Weekly', duration: '8 Weeks', instruction: 'With milk' },
    ],
    advice: 'TMT and 2D Echo before next visit. Low-salt, low-fat diet. Walk 30 minutes daily if no chest pain. Go to emergency immediately if chest pain lasts more than 10 minutes or does not settle with Sorbitrate.',
    reviewDate: dayStr(7),
  });
  for (const [off, dx, meds] of [
    [-40, 'Uncontrolled blood sugar', [{ name: 'Tab Metformin 500mg', dosage: '1-0-1', duration: 'Continue', instruction: 'After food' }]],
    [-90, 'Hypertension — new diagnosis', [{ name: 'Tab Telmisartan 40mg', dosage: '1-0-0', duration: 'Continue', instruction: 'Morning' }]],
  ]) {
    const t = await visit({ ...A, patient: P.chronic, offset: off, status: TOKEN_STATUS.COMPLETED, complaint: dx });
    await rx(t, ananya, P.chronic, { diagnosis: dx, medicines: meds, advice: 'Repeat sugar/BP log', when: at(off, 11) });
  }

  // Fill Ananya's morning to capacity (10), so the roster shows FULL.
  const aCount = await OPDToken.countDocuments({ doctorId: ananya._id, date: today, shift: 'MORNING', status: { $nin: ['CANCELLED', 'RESCHEDULE_NEEDED'] } });
  for (let i = aCount; i < 10; i += 1) {
    await visit({ ...A, patient: crowd[2 + i], status: TOKEN_STATUS.WAITING, checkIn: minsAgo(5 + i), pay: { cash: 0, upi: 600, card: 0 } });
  }

  // ---- TODAY: Dr. Priya Nair (CareWell) — 12 waiting, chamber empty ----
  for (let i = 0; i < 12; i += 1) {
    await visit({ doctor: priya, hospital: h2, patient: crowd[15 + i], status: TOKEN_STATUS.WAITING,
      visitType: i === 4 ? 'emergency' : 'fresh', checkIn: minsAgo(70 - i * 5), collector: receptionist2,
      complaint: i === 4 ? 'High fever with convulsion' : pick(['Fever', 'Cough & cold', 'Vaccination', 'Ear pain', 'Rash']) });
  }
  await visit({ doctor: priya, hospital: h2, patient: P.child, status: TOKEN_STATUS.COMPLETED, checkIn: at(0, 8, 10), collector: receptionist2, complaint: 'Vaccination — MMR' });

  // ---- HISTORY: 45 days of footfall and money, plus months back ----
  // Shape: a quiet Sunday each week, one huge day (a health camp), one day
  // with nothing at all, and an evening peak so "peak hour" is not just 10 AM.
  for (let off = -45; off <= -1; off += 1) {
    const sunday = DOW(off) === 0;
    const camp = off === -12;
    const dead = off === -20;
    if (dead) continue;
    const n = camp ? 22 : sunday ? 1 : 3 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i += 1) {
      const doc = i % 3 === 0 ? sandeep : i % 3 === 1 ? ananya : priya;
      const hosp = doc === priya ? h2 : h1;
      const hour = i % 4 === 0 ? 18 : 9 + Math.floor(rand() * 4);
      const r = rand();
      await visit({
        doctor: doc, hospital: hosp, patient: crowd[Math.floor(rand() * crowd.length)], offset: off,
        status: r < 0.08 ? TOKEN_STATUS.SKIPPED : r < 0.11 ? TOKEN_STATUS.CANCELLED : TOKEN_STATUS.COMPLETED,
        visitType: r > 0.93 ? 'emergency' : r > 0.7 ? 'followup' : 'fresh',
        checkIn: at(off, hour, Math.floor(rand() * 59)),
        pay: r < 0.45 ? undefined : r < 0.8 ? { upi: doc.fees[r > 0.93 ? 'emergency' : r > 0.7 ? 'followup' : 'fresh'] } : { card: doc.fees[r > 0.93 ? 'emergency' : r > 0.7 ? 'followup' : 'fresh'] },
        source: r > 0.6 ? TOKEN_SOURCE.APP : TOKEN_SOURCE.WALKIN,
        collector: hosp === h2 ? receptionist2 : undefined,
      });
    }
  }
  // Months back, for the month-bucketed charts and the 6-month trend.
  for (const off of [-75, -110, -140, -170]) {
    for (let i = 0; i < 4; i += 1) {
      await visit({ doctor: sandeep, hospital: h1, patient: crowd[i], offset: off, checkIn: at(off, 11, i * 10) });
    }
  }

  // ---- Petty cash ----
  await petty(h1, 0, 120, 'Tea & water', { note: 'Morning staff tea' });
  await petty(h1, 0, 450, 'Gloves & masks', { note: 'Medplus bill #4471' });
  await petty(h1, 0, 300, 'Cleaning', { voided: 'Entered twice by mistake' });
  await petty(h1, -1, 1850, 'Repairs', { note: 'AC service in Chamber 201' });
  await petty(h1, -3, 60, 'Courier', {});
  await petty(h2, 0, 200, 'Stationery', { by: receptionist2, note: 'Receipt rolls' });
  await petty(h2, -2, 95000, 'Repairs', { by: receptionist2, note: 'Large one-off: generator overhaul (tests big numbers)' });
  await petty(h2, -2, 95000, 'Repairs', { by: receptionist2, voided: 'Duplicate of the generator entry' });

  // ---- Counters, so the next real booking or walk-in does not collide ----
  // Lined up with every token that exists today and later, not only the ones
  // seeded here: the base seed's tokens need it too.
  const highest = await OPDToken.aggregate([
    { $match: { date: { $gte: dayStr(-60) } } },
    { $group: { _id: { d: '$doctorId', date: '$date', shift: '$shift' }, n: { $max: '$tokenNumber' } } },
  ]);
  for (const h of highest) {
    const shift = h._id.shift || 'MORNING';
    await Counter.updateOne({ _id: tokenCounterId(h._id.d, h._id.date, shift) }, { $max: { seq: h.n } }, { upsert: true });
    await Counter.updateOne({ _id: tokenCounterId(h._id.d, h._id.date) }, { $max: { seq: h.n } }, { upsert: true });
  }

  // ---- FIELD AGENTS ----
  const pwd = await hashPassword(PASSWORD);
  const agent2 = await User.findOneAndUpdate({ phone: '9000000023' },
    { $setOnInsert: { phone: '9000000023', name: 'Dipankar Hazra', role: ROLES.FIELD_AGENT, passwordHash: pwd, districtId: kol._id, isActive: true } },
    { new: true, upsert: true });
  const agent3 = await User.findOneAndUpdate({ phone: '9000000024' },
    { $setOnInsert: { phone: '9000000024', name: 'Nandini Sarkar', role: ROLES.FIELD_AGENT, passwordHash: pwd, districtId: kol._id, isActive: true } },
    { new: true, upsert: true });

  const lead = async (agent, district, data, visits = []) => {
    const l = track(ClinicLead, await ClinicLead.create({
      agentId: agent._id, districtId: district._id, ...data,
      visits: visits.map(([when, outcome, note, next]) => ({ at: when, outcome, note, nextVisitAt: next ?? null })),
    }));
    if (visits.length) await ClinicLead.collection.updateOne({ _id: l._id }, { $set: { createdAt: visits[0][0] } });
    return l;
  };
  const submission = async (agent, district, name, { status, submittedAt, reviewedAt, reviewer, reason, geocode = true, createdHospitalId = null, leadId = null, i }) => {
    const s = track(OnboardingSubmission, await OnboardingSubmission.create({
      kind: 'HOSPITAL', agentId: agent._id, districtId: district._id, status,
      payload: {
        name, code: `MG-EDGE-${String(i).padStart(3, '0')}`, type: 'CLINIC', licenseNumber: `WB-EDGE-${String(i).padStart(4, '0')}`,
        subscriptionPlan: 'BASIC', address: { line1: `${i} Edge Lane`, city: district.name, state: 'West Bengal', pincode: '700001' },
        primaryContact: { name: 'Front Desk', phone: `96000${String(i).padStart(5, '0')}` },
      },
      geocodeResult: geocode ? { lat: 22.5 + i / 1000, lng: 88.35, formatted: `${district.name}`, accuracy: 'PLACES' } : undefined,
      submittedAt, reviewedAt, reviewedBy: reviewer?._id, rejectionReason: reason,
      createdHospitalId, leadId,
    }));
    if (submittedAt) await OnboardingSubmission.collection.updateOne({ _id: s._id }, { $set: { createdAt: submittedAt } });
    return s;
  };

  // Suresh (Kolkata) — every follow-up state.
  await lead(suresh, kol, { clinicName: 'Overdue: Shanti Polyclinic', contactName: 'Dr. S. Banerjee', contactPhone: '9830011111', specialty: 'General Medicine',
    address: { line1: '12 Lake Road, Kalighat', city: 'Kolkata', pincode: '700029' }, stage: 'FOLLOW_UP', nextVisitAt: daysAhead(-5, 11) }, [
    [daysAgo(20), 'NOT_AVAILABLE', 'Doctor in OT all morning', daysAgo(15)],
    [daysAgo(15), 'MET', 'Liked the token system, wants to see pricing', daysAgo(8)],
    [daysAgo(8), 'RESCHEDULED', 'Asked to come after Durga Puja', daysAhead(-5, 11)],
  ]);
  await lead(suresh, kol, { clinicName: 'Due earlier today: Lifeline Clinic', contactName: 'Dr. R. Ghosh', contactPhone: '9830022222',
    address: { line1: '8 Hazra Road', city: 'Kolkata', pincode: '700026' }, stage: 'FOLLOW_UP', nextVisitAt: minsAgo(90) }, [
    [daysAgo(3), 'MET', 'Wants the receptionist trained first', minsAgo(90)],
  ]);
  await lead(suresh, kol, { clinicName: 'Due later today: Arogya Seva', contactName: 'Dr. P. Mitra', contactPhone: '9830033333',
    address: { line1: '22 Rashbehari Ave', city: 'Kolkata', pincode: '700019' }, stage: 'FOLLOW_UP', nextVisitAt: at(0, 21, 30) }, [
    [daysAgo(2), 'RESCHEDULED', 'Evening only — after 9 PM', at(0, 21, 30)],
  ]);
  await lead(suresh, kol, { clinicName: 'Tomorrow: Nirmal Health Point', contactName: 'Dr. A. Saha', specialty: 'Pediatrics',
    address: { line1: '3 Park Circus', city: 'Kolkata', pincode: '700017' }, stage: 'FOLLOW_UP', nextVisitAt: daysAhead(1, 11) }, [
    [daysAgo(1), 'MET', '', daysAhead(1, 11)],
  ]);
  await lead(suresh, kol, { clinicName: 'Next week: Sanjeevani Diagnostics', contactName: 'Mr. K. Dey', contactPhone: '9830044444',
    stage: 'FOLLOW_UP', nextVisitAt: daysAhead(7, 16) }, [
    [daysAgo(4), 'NOT_AVAILABLE', 'Owner travelling', daysAhead(7, 16)],
  ]);
  await lead(suresh, kol, { clinicName: 'Interested, no date: Care & Cure', contactName: 'Dr. M. Roy', contactPhone: '9830055555',
    address: { line1: '40 Gariahat', city: 'Kolkata', pincode: '700029' }, stage: 'INTERESTED', nextVisitAt: null }, [
    [daysAgo(6), 'MET', 'Comparing with another app'],
    [daysAgo(2), 'INTERESTED', 'Ready — bring licence form and standee'],
  ]);
  await lead(suresh, kol, { clinicName: 'New, never visited: City Dental', stage: 'NEW', nextVisitAt: null }, []);
  await lead(suresh, kol, { clinicName: 'Not interested: MedPlus Clinic', contactName: 'Dr. T. Pal', stage: 'NOT_INTERESTED', nextVisitAt: null }, [
    [daysAgo(10), 'NOT_INTERESTED', 'Already uses Practo, locked into a 2-year contract'],
  ]);
  // Long history and a very long note.
  const longNote = 'Spoke to Dr. Chatterjee and her husband who manages the clinic. They run two shifts and see about 60 patients a day. Main worry: the queue display needs Bengali, and the older patients do not use smartphones, so walk-in tokens must stay. Asked for a demo on a Sunday with the receptionist present, and a written quote for the standee. Follow up with the pricing sheet and Bengali screenshots.';
  await lead(suresh, kol, { clinicName: 'Busy history: Chatterjee Nursing Home', contactName: 'Dr. N. Chatterjee', contactPhone: '9830066666',
    address: { line1: '101 Southern Avenue', city: 'Kolkata', pincode: '700029' }, stage: 'FOLLOW_UP', nextVisitAt: daysAhead(2, 10),
    notes: 'Two shifts, ~60 patients/day' }, [
    [daysAgo(40), 'NOT_AVAILABLE', 'Closed for renovation', daysAgo(33)],
    [daysAgo(33), 'MET', 'Met the husband only', daysAgo(26)],
    [daysAgo(26), 'RESCHEDULED', 'Doctor ill', daysAgo(21)],
    [daysAgo(21), 'MET', 'Demo given on phone', daysAgo(14)],
    [daysAgo(14), 'RESCHEDULED', 'Puja holidays', daysAgo(7)],
    [daysAgo(7), 'MET', longNote, daysAgo(3)],
    [daysAgo(3), 'RESCHEDULED', 'Wants Sunday demo', daysAhead(2, 10)],
  ]);

  // Submissions for Suresh: pending (old, no map pin), under review, approved
  // this month (attached to a real clinic, for the impact numbers), approved
  // two months ago, rejected (with reason, resubmittable), and a draft.
  const pendingLead = await lead(suresh, kol, { clinicName: 'Pending 4 days: Hope Clinic', stage: 'SUBMITTED', submittedAt: daysAgo(4) }, [
    [daysAgo(9), 'INTERESTED', 'Signed the form'], [daysAgo(4), 'ONBOARDED', 'Submitted for district approval'],
  ]);
  const sPending = await submission(suresh, kol, 'Pending 4 days: Hope Clinic', { status: SUBMISSION_STATUS.SUBMITTED, submittedAt: daysAgo(4), geocode: false, leadId: pendingLead._id, i: 1 });
  await ClinicLead.updateOne({ _id: pendingLead._id }, { $set: { submissionId: sPending._id } });
  await submission(suresh, kol, 'Under review: Green Leaf Clinic', { status: SUBMISSION_STATUS.UNDER_REVIEW, submittedAt: hoursAgo(20), i: 2 });
  const approvedLead = await lead(suresh, kol, { clinicName: 'Sunrise Multispeciality', stage: 'SUBMITTED', submittedAt: daysAgo(6) }, [
    [daysAgo(12), 'MET', 'Very keen'], [daysAgo(8), 'INTERESTED', ''], [daysAgo(6), 'ONBOARDED', 'Submitted for district approval'],
  ]);
  const sApproved = await submission(suresh, kol, 'Sunrise Multispeciality', { status: SUBMISSION_STATUS.APPROVED, submittedAt: daysAgo(6), reviewedAt: daysAgo(5), reviewer: execKol, createdHospitalId: h1._id, leadId: approvedLead._id, i: 3 });
  await ClinicLead.updateOne({ _id: approvedLead._id }, { $set: { submissionId: sApproved._id } });
  await submission(suresh, kol, 'Approved in a past month: Riverside Clinic', { status: SUBMISSION_STATUS.APPROVED, submittedAt: daysAgo(65), reviewedAt: daysAgo(58), reviewer: execKol, i: 4 });
  const rejectedLead = await lead(suresh, kol, { clinicName: 'Rejected: Apollo Care Point', contactName: 'Dr. B. Sen', contactPhone: '9830077777', stage: 'SUBMITTED', submittedAt: daysAgo(3) }, [
    [daysAgo(5), 'INTERESTED', ''], [daysAgo(3), 'ONBOARDED', 'Submitted for district approval'],
  ]);
  const sRejected = await submission(suresh, kol, 'Rejected: Apollo Care Point', { status: SUBMISSION_STATUS.REJECTED, submittedAt: daysAgo(3), reviewedAt: daysAgo(2), reviewer: execKol, reason: 'Licence number does not match the clinic name on the certificate. Please re-check and resubmit.', leadId: rejectedLead._id, i: 5 });
  await ClinicLead.updateOne({ _id: rejectedLead._id }, { $set: { submissionId: sRejected._id } });
  await submission(suresh, kol, 'Draft, never sent: Pulse Clinic', { status: SUBMISSION_STATUS.DRAFT, i: 6 });

  // District peers, so Suresh has a rank: Dipankar leads, Nandini has none.
  for (let k = 0; k < 3; k += 1) {
    await submission(agent2, kol, `Dipankar clinic ${k + 1}`, { status: SUBMISSION_STATUS.APPROVED, submittedAt: daysAgo(9 - k), reviewedAt: daysAgo(8 - k), reviewer: execKol, i: 10 + k });
  }
  await lead(agent2, kol, { clinicName: 'Dipankar follow-up', stage: 'FOLLOW_UP', nextVisitAt: daysAhead(1) }, [[daysAgo(2), 'MET', '', daysAhead(1)]]);
  await lead(agent3, kol, { clinicName: 'Nandini first visit', stage: 'FOLLOW_UP', nextVisitAt: daysAhead(-2) }, [[daysAgo(5), 'MET', 'First week on the job', daysAhead(-2)]]);
  // Howrah: a pending submission for the Howrah admin to approve.
  await submission(meera, how, 'Howrah pending: Bally Health Centre', { status: SUBMISSION_STATUS.SUBMITTED, submittedAt: hoursAgo(30), i: 20 });

  // ---- Manifest ----
  await db.collection('seed_manifest').updateOne(
    { _id: MANIFEST_ID },
    { $set: { ids: created, at: new Date() } },
    { upsert: true },
  );

  const count = (m) => created[m]?.length ?? 0;
  console.log(`
─────────────────────────────────────────────────────────────
  EDGE-CASE DATA SEEDED (${today})
─────────────────────────────────────────────────────────────
  ${count('OPDToken')} tokens · ${count('Transaction')} receipts · ${count('Prescription')} prescriptions
  ${count('PettyExpense')} petty-cash entries · ${count('ClinicLead')} clinic leads · ${count('OnboardingSubmission')} submissions

  DOCTOR / FRONT DESK  (doctor 9000000102 Dr. Ananya Roy, desk 9000000031)
   • In chamber for 95 min — timer past an hour; very long name,
     long complaint, 5 conditions
   • Emergency waiting, split payment (cash+UPI+card), ₹0 staff visit,
     unbilled patient with no phone/age/gender
   • Follow-up token past its confirm-by time → "Release" button
   • Skipped (with reason), cancelled (hidden), refunded receipt
   • Completed with "Proceeded for Test" and "Admitted" outcomes
   • Biswajit Mukherjee: 8-medicine prescription + 2 older Rx (EMR history)
   • Morning sitting full (10/10) on the Roster

  ROSTER / LIVE MONITOR  (super admin 9000000001)
   • Sandeep: two sittings, capped + uncapped
   • Ananya: consulting, full sitting, emergency waiting
   • Priya Nair: 12 waiting, nobody in chamber (1 emergency)
   • Vikram: on a break that overran 20 min · Sunita: off today
     (conference) · Kavita: bookings closed, no schedule

  ANALYTICS / FINANCIAL AUDIT
   • 45 days of history: quiet Sundays, a 22-patient camp day 12 days
     ago, one empty day 20 days ago, an evening peak
   • Data 2–6 months back (month buckets, 6-month trend)
   • Petty cash: today (2 standing, 1 voided), ₹1,850 yesterday,
     ₹95,000 at CareWell (+ its voided duplicate)

  FIELD AGENT  (9000000021 Suresh Kumar)
   • Overdue 5 days · due earlier today (overdue by hours) · due tonight
     · tomorrow · next week · interested with no date · never visited
     · not interested · 7-visit history with a very long note
   • Approvals: pending 4 days with no map pin, under review, approved
     (impact = Sunrise), approved 2 months ago, rejected with reason
     (resubmit), draft never sent
   • Rank 2 of 3 in Kolkata (Dipankar Hazra 9000000023 leads; Nandini
     Sarkar 9000000024 has none) · Howrah admin 9000000012 has a pending
     approval
  All passwords: ${PASSWORD}
─────────────────────────────────────────────────────────────
`);
  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error({ err }, 'edge-case seed failed');
  process.exit(1);
});
