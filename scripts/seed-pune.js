/**
 * Reseed the network for Pune district.
 *
 * Clinics, doctors, bookings and payments are created by calling the real HTTP
 * API, not by writing to collections: the onboarding endpoint geocodes each
 * address through Google, approval enforces that a clinic without coordinates
 * can never go live, and booking allocates token numbers through the same
 * counter the front desk uses. Seeding around any of that would produce data
 * the application itself would have refused.
 *
 * Districts and patient accounts have no public endpoint, so those are written
 * with the models. Everything else goes over the wire.
 *
 * Addresses are real Pune locations with their correct pincodes, so the
 * geocoder returns genuine coordinates and the map is not a fiction.
 *
 *   node scripts/seed-pune.js --wipe        # clear then seed
 *   node scripts/seed-pune.js               # seed on top of what exists
 *
 * Requires the API to be running (API_BASE, default http://localhost:4000).
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { hashPassword } from '../src/modules/auth/service.js';
import { clinicDate } from '../src/lib/dates.js';
import {
  User, District, Hospital, Doctor, OPDToken, Transaction,
  OnboardingSubmission, QRStandee, Ticket, Counter, PatientPolicy, syncAllIndexes,
} from '../src/models/index.js';
import { ROLES } from '../src/config/constants.js';

const API = process.env.API_BASE || 'http://localhost:4000';
const WIPE = process.argv.includes('--wipe');
const PASSWORD = 'Mediigo@123';
const SUPER_PHONE = '9000000001';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- HTTP

let superToken = null;

const call = async (method, path, body, token = superToken) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`${method} ${path} → ${json.error?.message || res.status}`);
  return json.data;
};

const login = async (identifier, password = PASSWORD) => {
  const d = await call('POST', '/api/auth/staff/login', { identifier, password }, null);
  return d.accessToken;
};

const patientLogin = async (phone, name) => {
  await call('POST', '/api/auth/otp/request', { phone }, null);
  const d = await call('POST', '/api/auth/otp/verify', { phone, otp: '1234', name }, null);
  return d.accessToken;
};

// ---------------------------------------------------------------- data

// Real Pune localities with their actual pincodes, so geocoding resolves to
// the right part of the city rather than dropping every clinic on one point.
const DISTRICTS = [
  { name: 'Pune City', code: 'MH-PUN', state: 'Maharashtra', cityTier: 1, lng: 73.8567, lat: 18.5204 },
  { name: 'Pimpri-Chinchwad', code: 'MH-PCM', state: 'Maharashtra', cityTier: 1, lng: 73.7997, lat: 18.6298 },
  { name: 'Haveli', code: 'MH-HAV', state: 'Maharashtra', cityTier: 2, lng: 73.9260, lat: 18.4529 },
  { name: 'Maval', code: 'MH-MVL', state: 'Maharashtra', cityTier: 3, lng: 73.4700, lat: 18.7500 },
];

const CLINICS = [
  { code: 'MG-PUN-001', name: 'Kothrud Care Multispeciality', line1: 'Plot 9B, Paud Road, Lokmanya Colony', city: 'Kothrud, Pune', pincode: '411038', district: 'MH-PUN', phone: '9020000001', contact: 'Meera Joshi' },
  { code: 'MG-PUN-002', name: 'Baner Life Clinic', line1: 'Meadows Avenue, Baner Pashan Link Road', city: 'Baner, Pune', pincode: '411045', district: 'MH-PUN', phone: '9020000002', contact: 'Rohit Deshpande' },
  { code: 'MG-PUN-003', name: 'Aundh Wellness Centre', line1: 'Soham Complex, D P Road, Aundh', city: 'Aundh, Pune', pincode: '411007', district: 'MH-PUN', phone: '9020000003', contact: 'Sneha Kulkarni' },
  { code: 'MG-PUN-004', name: 'Viman Nagar Polyclinic', line1: 'Nagar Road, Viman Nagar', city: 'Viman Nagar, Pune', pincode: '411014', district: 'MH-PUN', phone: '9020000004', contact: 'Amit Patil' },
  { code: 'MG-PUN-005', name: 'Shivajinagar Health Hub', line1: '1160/61, University Road, Shivajinagar', city: 'Shivajinagar, Pune', pincode: '411005', district: 'MH-PUN', phone: '9020000005', contact: 'Vaishali Rane' },
  { code: 'MG-PUN-006', name: 'Erandwane Family Clinic', line1: 'Off Karve Road, Erandwane', city: 'Erandwane, Pune', pincode: '411004', district: 'MH-PUN', phone: '9020000006', contact: 'Nilesh Gokhale' },
  { code: 'MG-PUN-007', name: 'Koregaon Park Medicare', line1: 'Lane 7, Koregaon Park', city: 'Koregaon Park, Pune', pincode: '411001', district: 'MH-PUN', phone: '9020000007', contact: 'Farida Mistry' },
  { code: 'MG-HAV-001', name: 'Hadapsar Community Clinic', line1: 'Shatanand Complex, Gadital, Hadapsar', city: 'Hadapsar, Pune', pincode: '411028', district: 'MH-HAV', phone: '9020000008', contact: 'Sanjay Pawar' },
  { code: 'MG-HAV-002', name: 'Kharadi Prime Clinic', line1: 'Kul Scapes, Magarpatta Road, Kharadi', city: 'Kharadi, Pune', pincode: '411014', district: 'MH-HAV', phone: '9020000009', contact: 'Pooja Shinde' },
  { code: 'MG-PCM-001', name: 'Wakad Family Health', line1: 'Bhumkar Wasti, Hinjewadi Road, Wakad', city: 'Wakad, Pimpri-Chinchwad', pincode: '411057', district: 'MH-PCM', phone: '9020000010', contact: 'Ganesh More' },
  { code: 'MG-PCM-002', name: 'Chinchwad Sparsh Clinic', line1: 'Chinchwad Station Road, Chinchwad', city: 'Chinchwad, Pimpri-Chinchwad', pincode: '411033', district: 'MH-PCM', phone: '9020000011', contact: 'Asha Bhosale' },
  { code: 'MG-PUN-008', name: 'Bibwewadi Neighbourhood Clinic', line1: 'Parnkuti Building, Bibwewadi Road, Vasant Baug', city: 'Bibwewadi, Pune', pincode: '411037', district: 'MH-PUN', phone: '9020000012', contact: 'Prakash Jadhav' },
];

const SPECIALTIES = [
  'General Medicine', 'Cardiology', 'Pediatrics', 'Orthopedics', 'Dermatology',
  'ENT', 'Gynecology', 'Dentistry',
];

const FIRST = ['Aditi', 'Rahul', 'Sneha', 'Vikram', 'Prachi', 'Nikhil', 'Manasi', 'Suresh', 'Kavita', 'Abhijit',
  'Shruti', 'Mandar', 'Rupali', 'Yogesh', 'Trupti', 'Sameer', 'Anjali', 'Girish', 'Neha', 'Pravin',
  'Swapnil', 'Jyoti', 'Kedar', 'Madhuri', 'Tushar', 'Smita', 'Chetan', 'Vaibhavi', 'Omkar', 'Harshada'];
const LAST = ['Deshmukh', 'Kulkarni', 'Joshi', 'Patil', 'Jadhav', 'Sawant', 'Gokhale', 'Pawar', 'Shinde', 'Bhosale',
  'Chavan', 'Kadam', 'Nene', 'Ranade', 'Phadke'];

const pick = (arr, i) => arr[i % arr.length];
const pad = (n, w = 2) => String(n).padStart(w, '0');

// Weekly patterns, so different doctors are open on different days and the
// 7-day picker has variety to show rather than one uniform grid.
const PATTERNS = [
  { days: [1, 2, 3, 4, 5], shift: 'MORNING', startTime: '09:00', endTime: '13:00', maxTokens: null },
  { days: [1, 3, 5], shift: 'EVENING', startTime: '17:00', endTime: '20:00', maxTokens: 15 },
  { days: [1, 2, 3, 4, 5, 6], shift: 'MORNING', startTime: '10:00', endTime: '14:00', maxTokens: null },
  { days: [2, 4, 6], shift: 'EVENING', startTime: '18:00', endTime: '21:00', maxTokens: 12 },
  { days: [0, 6], shift: 'MORNING', startTime: '10:00', endTime: '13:00', maxTokens: 20 },
  { days: [1, 2, 3, 4, 5], shift: 'AFTERNOON', startTime: '14:00', endTime: '17:00', maxTokens: null },
];

// ---------------------------------------------------------------- wipe

const wipe = async () => {
  log('\nclearing the existing network…');
  const keep = await User.findOne({ phone: SUPER_PHONE }).lean();
  if (!keep) throw new Error(`Super Admin ${SUPER_PHONE} not found — refusing to wipe with no way back in`);

  const counts = {};
  for (const [name, Model] of Object.entries({
    tickets: Ticket, standees: QRStandee, transactions: Transaction, tokens: OPDToken,
    submissions: OnboardingSubmission, policies: PatientPolicy, doctors: Doctor,
    hospitals: Hospital, districts: District, counters: Counter,
  })) {
    counts[name] = (await Model.deleteMany({})).deletedCount;
  }
  counts.users = (await User.deleteMany({ _id: { $ne: keep._id } })).deletedCount;

  log('  ' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · '));
  log(`  kept Super Admin ${keep.name}`);
};

// ---------------------------------------------------------------- seed

const run = async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  await syncAllIndexes();

  // Fail fast rather than half-seeding against a dead API.
  const health = await fetch(`${API}/healthz`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`API not reachable at ${API} — start the server first`);
  log(`api: ${API}`);

  if (WIPE) await wipe();

  superToken = await login(SUPER_PHONE);
  log('signed in as Super Admin\n');

  // ---- districts (no endpoint for creation with centroid, so models) ----
  log('districts');
  const districtBy = {};
  for (const d of DISTRICTS) {
    const doc = await District.findOneAndUpdate(
      { code: d.code },
      {
        $set: {
          name: d.name, code: d.code, state: d.state, cityTier: d.cityTier,
          centroid: { type: 'Point', coordinates: [d.lng, d.lat] },
        },
      },
      { upsert: true, new: true },
    );
    districtBy[d.code] = doc;
    log(`  ${d.name} (${d.code})`);
  }

  // ---- staff: exec admins and field agents, via the staff API ----
  log('\nstaff');
  const agents = [];
  let n = 1;
  for (const d of DISTRICTS) {
    const exec = await call('POST', '/api/superadmin/staff', {
      name: `${pick(FIRST, n + 4)} ${pick(LAST, n)}`,
      phone: `90000000${pad(10 + n)}`,
      role: ROLES.EXEC_ADMIN,
      email: `${d.code.toLowerCase()}.admin@mediigo.com`,
      districtId: String(districtBy[d.code]._id),
      password: PASSWORD,
    });
    log(`  exec  ${exec.user.name.padEnd(22)} ${exec.user.phone}  ${d.name}`);

    const agent = await call('POST', '/api/superadmin/staff', {
      name: `${pick(FIRST, n + 11)} ${pick(LAST, n + 3)}`,
      phone: `90000000${pad(20 + n)}`,
      role: ROLES.FIELD_AGENT,
      districtId: String(districtBy[d.code]._id),
      password: PASSWORD,
    });
    agents.push({ ...agent.user, districtCode: d.code });
    log(`  agent ${agent.user.name.padEnd(22)} ${agent.user.phone}  ${d.name}`);
    n += 1;
  }

  // ---- clinics: real onboarding + approval, so Google geocodes each one ----
  log('\nclinics (geocoded via the onboarding API)');
  const hospitals = [];
  for (const c of CLINICS) {
    const sub = await call('POST', '/api/onboarding/submissions', {
      kind: 'HOSPITAL',
      districtId: String(districtBy[c.district]._id),
      payload: {
        // Derive from the whole code: the last three digits repeat across
        // districts (MG-PUN-001 and MG-HAV-001 both end 001) and the licence
        // number is globally unique.
        name: c.name, code: c.code, licenseNumber: `MH-CLIN-${c.code.replace(/[^A-Z0-9]/gi, '')}`,
        type: 'CLINIC', subscriptionPlan: 'BASIC',
        address: { line1: c.line1, city: c.city, state: 'Maharashtra', pincode: c.pincode },
        primaryContact: { name: c.contact, phone: c.phone },
      },
    });
    await call('POST', `/api/onboarding/submissions/${sub._id}/submit`);
    const out = await call('POST', `/api/admin/submissions/${sub._id}/approve`);
    const h = out.hospital;
    const [lng, lat] = h.location.coordinates;
    hospitals.push(h);
    log(`  ${c.name.padEnd(34)} ${c.pincode}  ${lat.toFixed(4)},${lng.toFixed(4)}`);
    // The geocoder is rate-limited; a short pause keeps every clinic resolving.
    await sleep(250);
  }

  // ---- doctors: onboarding + approval, then a schedule via the API ----
  log('\ndoctors');
  const doctors = [];
  let di = 0;
  for (const h of hospitals) {
    // Two or three doctors per clinic, so specialty filters have something to cut.
    const howMany = 2 + (di % 2);
    for (let k = 0; k < howMany; k += 1) {
      const name = `Dr. ${pick(FIRST, di * 3 + k)} ${pick(LAST, di + k)}`;
      const phone = `90000001${pad(di * 3 + k + 1)}`;
      const specialty = pick(SPECIALTIES, di + k);

      const sub = await call('POST', '/api/onboarding/submissions', {
        kind: 'DOCTOR',
        districtId: String(h.districtId),
        payload: {
          hospitalId: String(h._id),
          name, phone, specialty,
          councilRegNo: `MMC-${20000 + di * 3 + k}`,
          qualifications: k === 0 ? ['MBBS', 'MD'] : ['MBBS', 'DNB'],
          experienceYears: 4 + ((di + k) % 20),
          fees: { fresh: 400 + ((di % 4) * 100), followup: 200 + ((di % 3) * 50), emergency: 900 + ((di % 3) * 100) },
        },
      });
      await call('POST', `/api/onboarding/submissions/${sub._id}/submit`);
      const out = await call('POST', `/api/admin/submissions/${sub._id}/approve`);
      const doc = out.doctor;

      // A weekly pattern, expanded to the per-day rows the API stores.
      const pat = pick(PATTERNS, di + k);
      const extra = pick(PATTERNS, di + k + 3);
      const schedule = [
        ...pat.days.map((day) => ({ day, shift: pat.shift, startTime: pat.startTime, endTime: pat.endTime, maxTokens: pat.maxTokens })),
        ...extra.days.map((day) => ({ day, shift: extra.shift, startTime: extra.startTime, endTime: extra.endTime, maxTokens: extra.maxTokens })),
      ].filter((s, i, arr) => arr.findIndex((x) => x.day === s.day && x.shift === s.shift) === i);

      await call('PUT', `/api/doctors/${doc._id}/schedule`, { schedule });

      doctors.push({ ...doc, hospitalId: h._id, hospitalName: h.name, phone, specialty });
      log(`  ${name.padEnd(28)} ${specialty.padEnd(17)} ${h.name}`);
      di += 1;
    }
  }

  log(`\n  ${doctors.length} doctors across ${hospitals.length} clinics`);
  return { districtBy, hospitals, doctors, agents };
};

run()
  .then(async (ctx) => {
    // Patients and their bookings are seeded by the second half, kept in its
    // own module so a failure mid-way does not mean redoing the geocoding.
    const { seedPatientsAndQueues } = await import('./seed-pune-patients.js');
    await seedPatientsAndQueues({ ...ctx, API, PASSWORD, call, patientLogin, login, superToken });
    log('\ndone\n');
    await mongoose.disconnect();
  })
  .catch(async (e) => {
    console.error('\nseed failed:', e.message);
    await mongoose.disconnect();
    process.exit(1);
  });
