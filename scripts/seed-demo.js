/**
 * Demo data for the field agent: a month of clinic follow-ups for the
 * calendar, and onboarding submissions in every approval state, each with the
 * full wizard payload (facilities, OPD timings, receptionist, four doctors).
 * Run AFTER the base seed:
 *
 *   npm run seed && npm run seed:demo
 *
 * Everything lives in its own district (Pune City) with its own agent and
 * district admin, so it never mixes with the Kolkata edge cases. Dates are
 * relative to today, so the calendar is always full around the current date.
 *
 * Re-runnable: what it created last time is removed first (tracked in
 * `seed_manifest`). That includes any clinic, doctors and logins created by
 * approving one of its submissions during a demo, so the same submission can
 * be approved again after a re-run.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/modules/auth/service.js';
import { clinicDate } from '../src/lib/dates.js';
import {
  User, District, Hospital, Doctor, Specialty, ClinicLead, OnboardingSubmission,
} from '../src/models/index.js';
import { ROLES, SUBMISSION_STATUS } from '../src/config/constants.js';

const FORCE = process.argv.includes('--force');
const PASSWORD = 'Mediigo@123';
const TZ = env.DEFAULT_TIMEZONE;
const MANIFEST_ID = 'demo-field-agent';
const AGENT_PHONE = '9000000025';
const EXEC_PHONE = '9000000013';
// Every login a demo submission would create starts with this, and nothing
// else in the seeds does — which is what makes cleaning up approvals safe.
const LOGIN_PREFIX = '95';
const CODE_PREFIX = 'MG-DEMO-';

// ---- time helpers (clinic-local, IST) --------------------------------------

const dayStr = (offset = 0) => clinicDate(TZ, new Date(Date.now() + offset * 86400000));
/** A Date at hh:mm clinic time, `offset` days from today. */
const at = (offset, hh, mm = 0) => {
  const [y, m, d] = dayStr(offset).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60000);
};
const hoursAgo = (n) => new Date(Date.now() - n * 3600000);

// Deterministic "random", so every run gives the same shape.
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---- reference data ---------------------------------------------------------

const AREAS = [
  ['Kothrud', '411038', 18.5074, 73.8077], ['Aundh', '411007', 18.5590, 73.8076], ['Baner', '411045', 18.5590, 73.7868],
  ['Viman Nagar', '411014', 18.5679, 73.9143], ['Hadapsar', '411028', 18.5089, 73.9260], ['Kharadi', '411014', 18.5515, 73.9348],
  ['Wakad', '411057', 18.5987, 73.7650], ['Shivajinagar', '411005', 18.5308, 73.8475], ['Deccan Gymkhana', '411004', 18.5167, 73.8411],
  ['Camp', '411001', 18.5158, 73.8780], ['Kondhwa', '411048', 18.4721, 73.8897], ['Warje', '411058', 18.4826, 73.8019],
  ['Pashan', '411021', 18.5378, 73.7934], ['Magarpatta', '411013', 18.5158, 73.9272], ['Sinhagad Road', '411051', 18.4705, 73.8240],
];
const ROADS = ['Main Road', 'Station Road', 'Link Road', 'Market Lane', 'University Road', 'Highway Service Road'];
const FIRST = ['Rajesh', 'Amit', 'Sneha', 'Rahul', 'Priya', 'Vikram', 'Anjali', 'Sachin', 'Neha', 'Kiran', 'Pooja', 'Suresh', 'Meera', 'Arjun', 'Kavita', 'Nitin'];
const LAST = ['Sharma', 'Patil', 'Deshmukh', 'Joshi', 'Kulkarni', 'Pawar', 'Gokhale', 'Shinde', 'Jadhav', 'Bhosale', 'Kale', 'Apte'];
const CLINIC_WORDS = ['Sunrise', 'Lotus', 'Sahyadri', 'Shree', 'Navjeevan', 'Om Sai', 'Aarogya', 'Dhanvantari', 'Sanjeevani', 'Lifeline', 'Unity', 'Mauli', 'Ashirwad', 'Swasthya', 'Krishna', 'Aadhar', 'Jeevan Jyoti', 'Prime', 'Wellness First', 'Care Point'];
const CLINIC_KINDS = ['Multispeciality Clinic', 'Polyclinic', 'Child Care Clinic', 'Family Clinic', 'Ortho & Spine Centre', 'Heart Clinic', 'Skin & Hair Clinic', 'Dental Studio', 'Diabetes Centre', 'Maternity Home'];
const FACILITIES = [
  'In-house Pharmacy', 'Pathology / Blood Lab', 'Digital X-Ray / ECG', 'AC Waiting Lounge',
  'Ambulance Service', 'Free Wi-Fi for Patients', 'Wheelchair Accessible', 'Power Backup (Generator)',
  'Parking', 'Cashless / Insurance',
];
// Specialty name in the master → what the doctor card shows.
const DOCTOR_PROFILES = [
  { specialty: /cardio/i, quals: ['MBBS', 'MD (Cardiology)'], designation: 'Chief Cardiologist' },
  { specialty: /general|physician|medicine/i, quals: ['MBBS', 'DNB'], designation: 'General Physician' },
  { specialty: /ortho/i, quals: ['MBBS', 'MS (Ortho)'], designation: 'Orthopedic Surgeon' },
  { specialty: /pediat|paediat|child/i, quals: ['MBBS', 'DCH'], designation: 'Pediatrician' },
  { specialty: /derma|skin/i, quals: ['MBBS', 'MD (Dermatology)'], designation: 'Consultant Dermatologist' },
  { specialty: /gyn|obst/i, quals: ['MBBS', 'MS (OBGY)'], designation: 'Consultant Gynaecologist' },
];

const VISIT_NOTES = {
  MET: ['Explained the token system, doctor liked the live queue board', 'Met the receptionist, doctor was in OPD', 'Gave the pricing sheet, wants to discuss with partner', 'Showed the patient app demo on my phone'],
  RESCHEDULED: ['Doctor busy with emergency, asked to come next week', 'Asked to come after the evening OPD', 'Clinic closed for a family function', 'Will visit after Diwali rush'],
  NOT_AVAILABLE: ['Doctor out of station', 'Clinic shut — Sunday', 'Only compounder present'],
  INTERESTED: ['Ready to onboard — bring licence copy and standee', 'Wants all 3 doctors on it, collect their reg. numbers', 'Agreed on Basic plan, needs receptionist training'],
};

// ---- cleanup ---------------------------------------------------------------

const cleanPrevious = async (db) => {
  const manifest = await db.collection('seed_manifest').findOne({ _id: MANIFEST_ID });
  if (manifest?.ids?.ClinicLead?.length) await ClinicLead.deleteMany({ _id: { $in: manifest.ids.ClinicLead } });
  if (manifest?.ids?.OnboardingSubmission?.length) await OnboardingSubmission.deleteMany({ _id: { $in: manifest.ids.OnboardingSubmission } });

  // Clinics a demo approval created, with their doctors and logins.
  const hospitals = await Hospital.find({ code: new RegExp(`^${CODE_PREFIX}`) }).select('_id').lean();
  const hids = hospitals.map((h) => h._id);
  if (hids.length) {
    await Doctor.deleteMany({ hospitalId: { $in: hids } });
    await User.deleteMany({ hospitalId: { $in: hids }, role: { $in: [ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.CLINIC_ADMIN].filter(Boolean) } });
    await Hospital.deleteMany({ _id: { $in: hids } });
  }
  await User.deleteMany({ phone: new RegExp(`^${LOGIN_PREFIX}\\d{8}$`), role: { $in: [ROLES.DOCTOR, ROLES.RECEPTIONIST] } });
};

// ---- builders --------------------------------------------------------------

const created = { ClinicLead: [], OnboardingSubmission: [] };

const personName = (i) => `${FIRST[i % FIRST.length]} ${LAST[(i * 5 + 3) % LAST.length]}`;
const clinicName = (i) => `${CLINIC_WORDS[i % CLINIC_WORDS.length]} ${CLINIC_KINDS[(i * 3) % CLINIC_KINDS.length]}`;
const areaOf = (i) => AREAS[i % AREAS.length];

/** The full onboarding wizard payload, as AgentOnboardView sends it. */
const wizardPayload = (i, nDoctors, specialties) => {
  const [area, pincode, lat, lng] = areaOf(i);
  const name = clinicName(i);
  const n = String(i).padStart(3, '0');
  // 10 digits, unique per submission and doctor: 95 + submission(3) + slot(2) + 000.
  const login = (slot) => `${LOGIN_PREFIX}${n}${String(slot).padStart(2, '0')}000`;
  const domain = `${CLINIC_WORDS[i % CLINIC_WORDS.length].toLowerCase().replace(/[^a-z]/g, '')}clinic.in`;
  const doctors = Array.from({ length: nDoctors }, (_, d) => {
    const prof = DOCTOR_PROFILES[(i + d) % DOCTOR_PROFILES.length];
    const spec = specialties.find((s) => prof.specialty.test(s.name)) ?? specialties[(i + d) % specialties.length];
    const first = FIRST[(i * 3 + d * 7) % FIRST.length];
    const last = LAST[(i + d * 4) % LAST.length];
    return {
      name: `Dr. ${first} ${last}`,
      phone: login(d + 1),
      email: `dr.${first.toLowerCase()}@${domain}`,
      councilRegNo: `MMC-D${n}${d + 1}`,
      registrationCouncil: 'Maharashtra Medical Council',
      qualifications: prof.quals,
      designation: prof.designation,
      specialty: spec?.name ?? 'General Physician',
      specialtyIds: spec ? [String(spec._id)] : [],
      experienceYears: 5 + ((i * 7 + d * 3) % 18),
      fees: { fresh: 400 + 100 * (d % 3), followup: 200 + 50 * (d % 3), emergency: 800 + 100 * (d % 3) },
      isClinicAdmin: d === 0,
      photo: null,
    };
  });
  return {
    name,
    code: `${CODE_PREFIX}${n}`,
    type: nDoctors > 2 ? 'POLYCLINIC' : 'CLINIC',
    licenseNumber: `MH-CLIN-DEMO${n}`,
    subscriptionPlan: pick(['BASIC', 'PRO', 'FREE']),
    contactPhone: `98221${n}${String(40 + i).slice(-2)}`.slice(0, 10),
    contactEmail: `contact@${domain}`,
    address: {
      line1: `Plot ${10 + i}, ${pick(ROADS)}, ${area}`,
      line2: pick(['Near Central Hospital', 'Opp. Bus Stop', 'Above HDFC Bank', 'Next to D-Mart', '']),
      city: 'Pune', district: 'Pune', state: 'Maharashtra', pincode,
    },
    geocode: { lat, lng, placeId: '', formatted: `${area}, Pune, Maharashtra ${pincode}`, source: 'MAP_PIN' },
    photos: [],
    consultationRooms: Math.max(1, nDoctors),
    facilities: FACILITIES.filter((_, k) => (i + k) % 3 !== 0),
    opd: {
      days: [1, 2, 3, 4, 5, 6],
      morning: { enabled: true, startTime: '09:00', endTime: '13:30' },
      evening: { enabled: i % 4 !== 0, startTime: '17:00', endTime: '21:00' },
      avgConsultMinutes: pick([8, 10, 12, 15]),
      maxTokensPerShift: i % 3 === 0 ? 40 : null,
    },
    primaryContact: { name: personName(i + 3), phone: login(0) },
    receptionistEmail: `reception@${domain}`,
    doctors,
  };
};

// ---- run --------------------------------------------------------------------

const run = async () => {
  if (env.NODE_ENV === 'production' && !FORCE) {
    logger.error('Refusing to seed in production without --force');
    process.exit(1);
  }
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  const { db } = mongoose.connection;

  const specialties = await Specialty.find({}).select('name').lean();
  if (!specialties.length) {
    logger.error('No specialties found — run `npm run seed` (and scripts/seed-specialties.js) first');
    process.exit(1);
  }

  await cleanPrevious(db);
  const pwd = await hashPassword(PASSWORD);

  // ---- district, its admin and the agent ----
  const pune = await District.findOneAndUpdate(
    { code: 'MH-PUN' },
    { $setOnInsert: { name: 'Pune City', code: 'MH-PUN', state: 'Maharashtra', cityTier: 1, centroid: { type: 'Point', coordinates: [73.8567, 18.5204] } } },
    { new: true, upsert: true },
  );
  const staff = async (phone, doc) => {
    const existing = await User.findOne({ phone }).lean();
    if (existing && existing.role !== doc.role) throw new Error(`${phone} already belongs to a ${existing.role} — free it or change the demo phone`);
    return User.findOneAndUpdate({ phone }, { $setOnInsert: { phone, passwordHash: pwd, isActive: true, ...doc } }, { new: true, upsert: true });
  };
  const exec = await staff(EXEC_PHONE, { name: 'Priyanka Kulkarni', role: ROLES.EXEC_ADMIN, email: 'pune.admin@mediigo.com', districtId: pune._id });
  const agent = await staff(AGENT_PHONE, { name: 'Rahul Sharma', role: ROLES.FIELD_AGENT, email: 'rahul.sharma@mediigo.com', districtId: pune._id });

  const lead = async (data, visits = []) => {
    const l = await ClinicLead.create({
      agentId: agent._id, districtId: pune._id, ...data,
      visits: visits.map(([when, outcome, note, next]) => ({ at: when, outcome, note: note ?? '', nextVisitAt: next ?? null })),
    });
    created.ClinicLead.push(l._id);
    if (visits.length) await ClinicLead.collection.updateOne({ _id: l._id }, { $set: { createdAt: visits[0][0] } });
    return l;
  };
  const leadBase = (i, extra = {}) => {
    const [area, pincode] = areaOf(i);
    return {
      clinicName: clinicName(i),
      contactName: `Dr. ${personName(i)}`,
      contactPhone: `98${String(23000000 + i * 104729).slice(-8)}`,
      specialty: pick(['General Medicine', 'Pediatrics', 'Orthopedics', 'Cardiology', 'Dermatology', 'Gynaecology', 'Dental']),
      address: { line1: `Shop ${3 + i}, ${pick(ROADS)}, ${area}`, city: 'Pune', pincode },
      ...extra,
    };
  };

  // ---- follow-ups: hand-picked cases first ----
  let li = 0;
  // Today: one already missed this morning, two still ahead.
  await lead(leadBase(li++, { stage: 'FOLLOW_UP', nextVisitAt: at(0, 9, 30), notes: 'Morning OPD only' }), [
    [at(-6, 11), 'MET', 'Liked the live queue board, wants to see it on a TV', at(0, 9, 30)],
  ]);
  await lead(leadBase(li++, { stage: 'INTERESTED', nextVisitAt: at(0, 17, 30) }), [
    [at(-9, 12), 'MET', VISIT_NOTES.MET[2], at(-3, 12)],
    [at(-3, 12, 15), 'INTERESTED', 'Ready to onboard — bring licence copy and standee', at(0, 17, 30)],
  ]);
  await lead(leadBase(li++, { stage: 'FOLLOW_UP', nextVisitAt: at(0, 20, 0) }), [
    [at(-2, 19), 'RESCHEDULED', 'Asked to come after the evening OPD', at(0, 20, 0)],
  ]);
  // Overdue by a few days to two weeks.
  for (const [days, hh] of [[1, 11], [3, 16], [7, 12], [12, 10]]) {
    await lead(leadBase(li++, { stage: 'FOLLOW_UP', nextVisitAt: at(-days, hh) }), [
      [at(-days - 8, 11), 'NOT_AVAILABLE', pick(VISIT_NOTES.NOT_AVAILABLE), at(-days - 4, 11)],
      [at(-days - 4, 11, 20), 'RESCHEDULED', pick(VISIT_NOTES.RESCHEDULED), at(-days, hh)],
    ]);
  }
  // Long history with a long note.
  await lead(leadBase(li++, { stage: 'FOLLOW_UP', nextVisitAt: at(2, 10, 30), notes: 'Two shifts, ~70 patients/day, 3 doctors' }), [
    [at(-30, 11), 'NOT_AVAILABLE', 'Clinic under renovation', at(-24, 11)],
    [at(-24, 11, 10), 'MET', 'Met the manager only', at(-17, 12)],
    [at(-17, 12, 5), 'MET', 'Demo to Dr. Gokhale, very positive', at(-10, 16)],
    [at(-10, 16, 30), 'RESCHEDULED', 'Doctor at a conference in Mumbai', at(-4, 11)],
    [at(-4, 11, 15), 'MET', 'Spoke to all three doctors and the manager. They see about 70 patients a day across two shifts. Main worry: older patients without smartphones must still get walk-in tokens, and the queue display should be in Marathi. Asked for a written quote for two standees and a Sunday training session for the receptionist.', at(2, 10, 30)],
  ]);
  // No date, not interested, never visited.
  await lead(leadBase(li++, { stage: 'INTERESTED', nextVisitAt: null }), [
    [at(-5, 12), 'MET', VISIT_NOTES.MET[0]], [at(-2, 13), 'INTERESTED', 'Agreed on Basic plan, needs receptionist training'],
  ]);
  await lead(leadBase(li++, { stage: 'NOT_INTERESTED', nextVisitAt: null }), [
    [at(-14, 11), 'MET', 'Uses another booking app'], [at(-8, 11), 'NOT_INTERESTED', 'Locked into a 2-year contract with another vendor'],
  ]);
  await lead(leadBase(li++, { stage: 'NEW', nextVisitAt: null }), []);

  // ---- then a spread over the last four weeks and the next five, ----
  // so every week of the calendar has scheduled, missed and visited days.
  const outcomes = ['MET', 'RESCHEDULED', 'NOT_AVAILABLE', 'MET', 'INTERESTED'];
  for (let k = 0; k < 26; k += 1) {
    const next = Math.round(-20 + (k * 55) / 25) + (k % 3 === 0 ? 1 : 0); // -20 … +35 days
    if (next === 0) continue;
    const hh = 9 + ((k * 5) % 11);
    const mm = [0, 15, 30, 45][k % 4];
    const nVisits = 1 + (k % 3);
    const visits = [];
    let when = next - 4 - nVisits * 5;
    for (let v = 0; v < nVisits; v += 1) {
      const outcome = v === nVisits - 1 && k % 5 === 4 ? 'INTERESTED' : outcomes[(k + v) % 4];
      const nextAt = v === nVisits - 1 ? at(next, hh, mm) : at(when + 5, 11);
      // Visits are in the past; a future follow-up starts from a visit no later than yesterday.
      const visitDay = Math.min(when, -1);
      visits.push([at(visitDay, 10 + ((k + v) % 8), (k * 7) % 60), outcome, pick(VISIT_NOTES[outcome] ?? VISIT_NOTES.MET), nextAt]);
      when += 5;
    }
    visits.sort((a, b) => a[0] - b[0]);
    const stage = visits[visits.length - 1][1] === 'INTERESTED' ? 'INTERESTED' : 'FOLLOW_UP';
    await lead(leadBase(li++, { stage, nextVisitAt: at(next, hh, mm) }), visits);
  }

  // ---- submissions: every approval state, full wizard payloads ----
  let si = 1;
  const submission = async ({ status, nDoctors = 4, submittedAt = null, reviewedAt = null, reason, notes, withLead = false }) => {
    const i = si++;
    const payload = wizardPayload(i + 40, nDoctors, specialties);
    let l = null;
    if (withLead) {
      l = await lead({
        clinicName: payload.name, contactName: payload.doctors[0].name, contactPhone: payload.contactPhone,
        address: { line1: payload.address.line1, city: 'Pune', pincode: payload.address.pincode },
        stage: status === SUBMISSION_STATUS.DRAFT ? 'INTERESTED' : 'SUBMITTED', submittedAt,
      }, [
        [new Date((submittedAt ?? new Date()).getTime() - 7 * 86400000), 'MET', pick(VISIT_NOTES.MET)],
        [new Date((submittedAt ?? new Date()).getTime() - 3 * 86400000), 'INTERESTED', pick(VISIT_NOTES.INTERESTED)],
        ...(submittedAt ? [[submittedAt, 'ONBOARDED', 'Submitted for district approval']] : []),
      ]);
    }
    const s = await OnboardingSubmission.create({
      kind: 'HOSPITAL', agentId: agent._id, districtId: pune._id, status, payload,
      geocodeResult: { lat: payload.geocode.lat, lng: payload.geocode.lng, formatted: payload.geocode.formatted, placeId: '', accuracy: 'MAP_PIN' },
      submittedAt, reviewedAt, reviewedBy: reviewedAt ? exec._id : undefined,
      rejectionReason: reason, reviewNotes: notes, leadId: l?._id ?? null,
    });
    created.OnboardingSubmission.push(s._id);
    await OnboardingSubmission.collection.updateOne({ _id: s._id }, { $set: { createdAt: submittedAt ?? hoursAgo(2) } });
    if (l) await ClinicLead.updateOne({ _id: l._id }, { $set: { submissionId: s._id } });
    return s;
  };

  await submission({ status: SUBMISSION_STATUS.SUBMITTED, submittedAt: hoursAgo(3), withLead: true });
  await submission({ status: SUBMISSION_STATUS.SUBMITTED, nDoctors: 2, submittedAt: hoursAgo(50), withLead: true });
  await submission({ status: SUBMISSION_STATUS.UNDER_REVIEW, nDoctors: 3, submittedAt: hoursAgo(26) });
  await submission({ status: SUBMISSION_STATUS.CHANGES_REQUESTED, nDoctors: 2, submittedAt: hoursAgo(80), reviewedAt: hoursAgo(60), notes: 'Clinic licence photo is blurry — please re-upload and confirm the second doctor’s registration number.' });
  await submission({ status: SUBMISSION_STATUS.REJECTED, nDoctors: 1, submittedAt: hoursAgo(120), reviewedAt: hoursAgo(100), withLead: true, reason: 'Licence number does not match the clinic name on the certificate. Please re-check and resubmit.' });
  for (const days of [2, 6, 11]) {
    await submission({ status: SUBMISSION_STATUS.APPROVED, nDoctors: 1 + (days % 3), submittedAt: hoursAgo(days * 24 + 20), reviewedAt: hoursAgo(days * 24) });
  }
  for (const days of [38, 52]) {
    await submission({ status: SUBMISSION_STATUS.APPROVED, nDoctors: 2, submittedAt: hoursAgo(days * 24 + 30), reviewedAt: hoursAgo(days * 24) });
  }
  await submission({ status: SUBMISSION_STATUS.DRAFT, nDoctors: 2, withLead: true });

  await db.collection('seed_manifest').updateOne({ _id: MANIFEST_ID }, { $set: { ids: created, at: new Date() } }, { upsert: true });

  console.log(`
─────────────────────────────────────────────────────────────
  FIELD AGENT DEMO SEEDED (${dayStr(0)}) — Pune City
─────────────────────────────────────────────────────────────
  ${created.ClinicLead.length} clinic leads · ${created.OnboardingSubmission.length} submissions

  LOGINS (password ${PASSWORD})
   • Field agent     ${AGENT_PHONE}  Rahul Sharma
   • District admin  ${EXEC_PHONE}  Priyanka Kulkarni (Pune City)

  FIELD AGENT  → /a/followups (Cards + Calendar), /a/onboard, /a/submissions
   • Today: one follow-up missed this morning, two still due this evening
   • Overdue by 1, 3, 7 and 12 days; ~25 more spread over the last
     4 weeks and the next 5, each with 1–3 logged visits (green dots)
   • Long 5-visit history with a long note; interested-no-date,
     not-interested and never-visited leads
   • Submissions: 2 awaiting approval, under review, changes requested,
     rejected (Resubmit from follow-ups), 3 approved this month,
     2 approved last month, 1 draft

  DISTRICT ADMIN → Approvals
   • Approve "${clinicName(41)}" to create the clinic with
     4 doctors (1 clinic admin) and a receptionist from the wizard data.
     Logins start with ${LOGIN_PREFIX}…; re-running this script removes them.
─────────────────────────────────────────────────────────────
`);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  logger.error({ err }, 'demo seed failed');
  await mongoose.disconnect();
  process.exit(1);
});
