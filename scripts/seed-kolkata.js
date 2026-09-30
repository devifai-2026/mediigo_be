/**
 * Seed a Kolkata network clustered around Ichhapur / Barrackpore.
 *
 * Everything goes through the real API — submission, submit, approve — rather
 * than writing documents directly, so a clinic seeded here is indistinguishable
 * from one an agent onboarded, and the seed exercises the same code path a real
 * onboarding does.
 *
 * Photos are uploaded for roughly 60% of doctors on purpose. A network where
 * everyone has a portrait never shows the initials fallback, so the one case
 * most likely to look broken in production is the one never seen in testing.
 *
 *   node scripts/seed-kolkata.js
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import '../src/models/index.js';
import { User, District, Specialty, Doctor, Hospital, toSlug } from '../src/models/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.SEED_API || `http://localhost:${env.PORT || 4000}`;
const SUPER_PHONE = '9000000001';
const PASSWORD = 'Mediigo@123';

// Portraits shipped with the client, reused so the seeded photos are real
// images rather than generated colour blocks.
const PORTRAITS = path.resolve(__dirname, '../../client/public/dummydoctors');

let token = null;

const call = async (method, p, body) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${json?.error?.message || ''}`);
  return json.data;
};

/**
 * Clinics along the Barrackpore–Sodepur corridor, north of Kolkata.
 *
 * Coordinates are real points on that stretch, spread 1-9km from Ichhapur
 * Defence Estate (22.801, 88.382) so the distance sort has something to sort
 * and the default 15km radius finds all of them.
 */
const CLINICS = [
  {
    code: 'MG-KOL-101', name: 'Ichhapur Family Health Centre',
    line1: '112 Prantik Road, Ichhapur Defence Estate', city: 'Ichhapur, Kolkata', pincode: '743144',
    lat: 22.8032, lng: 88.3841, contact: 'Ananya Ghosh', phone: '9030000001',
  },
  {
    code: 'MG-KOL-102', name: 'Barrackpore Wellness Clinic',
    line1: '7 Barrackpore Trunk Road, Nonachandanpukur', city: 'Barrackpore, Kolkata', pincode: '700122',
    lat: 22.7658, lng: 88.3712, contact: 'Debasish Roy', phone: '9030000002',
  },
  {
    code: 'MG-KOL-103', name: 'Titagarh Community Polyclinic',
    line1: '45 Talpukur Road, Titagarh', city: 'Titagarh, Kolkata', pincode: '700119',
    lat: 22.7401, lng: 88.3694, contact: 'Sharmila Dutta', phone: '9030000003',
  },
  {
    code: 'MG-KOL-104', name: 'Khardah Medicare',
    line1: '19 Rahara Station Road, Khardah', city: 'Khardah, Kolkata', pincode: '700117',
    lat: 22.7195, lng: 88.3778, contact: 'Pritam Banerjee', phone: '9030000004',
  },
  {
    code: 'MG-KOL-105', name: 'Sodepur Care Multispeciality',
    line1: '3 Ghola Bazar Road, Sodepur', city: 'Sodepur, Kolkata', pincode: '700110',
    lat: 22.6986, lng: 88.3853, contact: 'Moumita Sen', phone: '9030000005',
  },
  {
    code: 'MG-KOL-106', name: 'Shyamnagar Neighbourhood Clinic',
    line1: '88 Mulajore Road, Shyamnagar', city: 'Shyamnagar, Kolkata', pincode: '743127',
    lat: 22.8375, lng: 88.3739, contact: 'Arindam Pal', phone: '9030000006',
  },
];

/**
 * Doctors per clinic. `photo` names a portrait to upload, or null to leave them
 * without one so the initials fallback is exercised.
 *
 * Fees vary per doctor rather than per specialty — two paediatricians at the
 * same clinic routinely charge differently, and flat fees would hide that.
 */
const DOCTORS = [
  // Ichhapur
  { clinic: 0, name: 'Sujata Chatterjee', specialty: 'General Medicine', phone: '9031000001', reg: 'WBMC-31001', quals: ['MBBS', 'MD'], exp: 14, fees: [500, 250, 900], photo: 'doctorAditi.png' },
  { clinic: 0, name: 'Anirban Bose', specialty: 'Cardiology', phone: '9031000002', reg: 'WBMC-31002', quals: ['MBBS', 'MD', 'DM'], exp: 18, fees: [900, 450, 1600], photo: 'doctorKartik.png' },
  { clinic: 0, name: 'Rituparna Das', specialty: 'Pediatrics', phone: '9031000003', reg: 'WBMC-31003', quals: ['MBBS', 'DCH'], exp: 9, fees: [450, 200, 800], photo: null },
  // Barrackpore
  { clinic: 1, name: 'Soumitra Ghosh', specialty: 'Orthopedics', phone: '9031000004', reg: 'WBMC-31004', quals: ['MBBS', 'MS'], exp: 16, fees: [700, 350, 1200], photo: 'doctorPrakash.png' },
  { clinic: 1, name: 'Paromita Sen', specialty: 'Dermatology', phone: '9031000005', reg: 'WBMC-31005', quals: ['MBBS', 'MD'], exp: 7, fees: [600, 300, 1000], photo: 'doctorAditi.png' },
  { clinic: 1, name: 'Kaushik Mitra', specialty: 'General Medicine', phone: '9031000006', reg: 'WBMC-31006', quals: ['MBBS'], exp: 5, fees: [400, 200, 800], photo: null },
  // Titagarh
  { clinic: 2, name: 'Nandita Roy', specialty: 'Gynecology', phone: '9031000007', reg: 'WBMC-31007', quals: ['MBBS', 'MS'], exp: 12, fees: [650, 300, 1100], photo: 'doctorAditi.png' },
  { clinic: 2, name: 'Subhajit Kar', specialty: 'ENT', phone: '9031000008', reg: 'WBMC-31008', quals: ['MBBS', 'MS'], exp: 10, fees: [550, 275, 950], photo: 'doctorTushar.png' },
  { clinic: 2, name: 'Piyali Saha', specialty: 'Pediatrics', phone: '9031000009', reg: 'WBMC-31009', quals: ['MBBS', 'MD'], exp: 6, fees: [500, 250, 900], photo: null },
  // Khardah
  { clinic: 3, name: 'Tarun Bhattacharya', specialty: 'General Medicine', phone: '9031000010', reg: 'WBMC-31010', quals: ['MBBS', 'MD'], exp: 22, fees: [600, 300, 1000], photo: 'doctorVishal.png' },
  { clinic: 3, name: 'Ishita Mukherjee', specialty: 'Dentistry', phone: '9031000011', reg: 'WBMC-31011', quals: ['BDS', 'MDS'], exp: 8, fees: [400, 200, 700], photo: null },
  { clinic: 3, name: 'Arjun Nandi', specialty: 'Orthopedics', phone: '9031000012', reg: 'WBMC-31012', quals: ['MBBS', 'MS'], exp: 11, fees: [750, 350, 1300], photo: 'doctorAmol.png' },
  // Sodepur
  { clinic: 4, name: 'Madhumita Basu', specialty: 'Dermatology', phone: '9031000013', reg: 'WBMC-31013', quals: ['MBBS', 'MD'], exp: 13, fees: [700, 350, 1150], photo: 'doctorAditi.png' },
  { clinic: 4, name: 'Rajarshi Dutta', specialty: 'Cardiology', phone: '9031000014', reg: 'WBMC-31014', quals: ['MBBS', 'MD', 'DM'], exp: 20, fees: [1000, 500, 1800], photo: 'doctorKartik.png' },
  { clinic: 4, name: 'Sohini Pal', specialty: 'Gynecology', phone: '9031000015', reg: 'WBMC-31015', quals: ['MBBS', 'MS'], exp: 9, fees: [600, 300, 1050], photo: null },
  { clinic: 4, name: 'Abhijit Sarkar', specialty: 'ENT', phone: '9031000016', reg: 'WBMC-31016', quals: ['MBBS', 'DLO'], exp: 15, fees: [500, 250, 900], photo: 'doctorTushar.png' },
  // Shyamnagar
  { clinic: 5, name: 'Lopamudra Ghosh', specialty: 'Pediatrics', phone: '9031000017', reg: 'WBMC-31017', quals: ['MBBS', 'MD'], exp: 17, fees: [550, 275, 950], photo: 'doctorAditi.png' },
  { clinic: 5, name: 'Debjani Roy', specialty: 'General Medicine', phone: '9031000018', reg: 'WBMC-31018', quals: ['MBBS'], exp: 4, fees: [350, 175, 700], photo: null },
];

// A weekly pattern each doctor gets one of, so availability differs and the
// booking calendar has something real to show.
const PATTERNS = [
  { days: [1, 2, 3, 4, 5], shift: 'MORNING', startTime: '09:00', endTime: '13:00', maxTokens: 20 },
  { days: [1, 3, 5], shift: 'EVENING', startTime: '17:00', endTime: '20:00', maxTokens: 15 },
  { days: [2, 4, 6], shift: 'MORNING', startTime: '10:00', endTime: '14:00', maxTokens: 18 },
  { days: [1, 2, 3, 4, 5, 6], shift: 'EVENING', startTime: '18:00', endTime: '21:00', maxTokens: 12 },
];

const uploadPhoto = async (doctorId, fileName) => {
  const buf = await fs.readFile(path.join(PORTRAITS, fileName));
  const form = new FormData();
  form.append('photo', new Blob([buf], { type: 'image/png' }), fileName);
  const res = await fetch(`${API}/api/doctors/${doctorId}/photo`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`photo upload -> ${res.status}`);
  return (await res.json()).data?.photo?.url ?? null;
};

const run = async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  console.log(`db: ${env.MONGODB_DB_NAME}`);
  console.log(`api: ${API}\n`);

  token = (await call('POST', '/api/auth/staff/login', { identifier: SUPER_PHONE, password: PASSWORD })).accessToken;

  // The district has to exist before a clinic can reference it. Every district
  // in the database is Maharashtra, so Kolkata needs creating first.
  let district = await District.findOne({ code: 'WB-NRP' }).lean();
  if (!district) {
    district = await District.create({
      name: 'North 24 Parganas', code: 'WB-NRP', state: 'West Bengal', cityTier: 1,
      centroid: { type: 'Point', coordinates: [88.3784, 22.7625] },
    });
    console.log('district: created North 24 Parganas');
  } else {
    console.log('district: North 24 Parganas already present');
  }

  const specialties = await Specialty.find().select('name slug').lean();
  const specialtyBySlug = new Map(specialties.map((s) => [s.slug, s._id]));
  if (!specialties.length) {
    console.warn('No specialties found — run seed-specialties.js first, or doctors will not link to tiles.');
  }

  const hospitalIds = [];
  console.log('\nclinics');
  for (const c of CLINICS) {
    const existing = await Hospital.findOne({ code: c.code }).lean();
    if (existing) {
      hospitalIds.push(existing._id);
      console.log(`  ${c.name.padEnd(36)} already present`);
      continue;
    }

    const sub = await call('POST', '/api/onboarding/submissions', {
      kind: 'HOSPITAL',
      districtId: String(district._id),
      payload: {
        name: c.name, code: c.code, type: 'CLINIC',
        licenseNumber: `WB-LIC-${c.code.slice(-3)}`,
        address: { line1: c.line1, city: c.city, state: 'West Bengal', pincode: c.pincode },
        contactPhone: c.phone,
        primaryContact: { name: c.contact, phone: c.phone },
        subscriptionPlan: 'BASIC',
        // Supplying the coordinates skips the Google lookup. That matters here:
        // the geocoder would resolve these addresses to wherever it thinks they
        // are, scattering a deliberately clustered test network — and approval
        // refuses any hospital without a verified location.
        geocode: { lat: c.lat, lng: c.lng, formatted: `${c.line1}, ${c.city}` },
      },
    });
    await call('POST', `/api/onboarding/submissions/${sub._id}/submit`);
    const out = await call('POST', `/api/admin/submissions/${sub._id}/approve`, { password: PASSWORD });
    hospitalIds.push(out.hospital._id);
    console.log(`  ${c.name.padEnd(36)} created`);
  }

  console.log('\ndoctors');
  let withPhoto = 0;
  let withoutPhoto = 0;
  for (const [i, d] of DOCTORS.entries()) {
    const existing = await User.findOne({ phone: d.phone }).lean();
    if (existing) {
      console.log(`  ${d.name.padEnd(24)} already present`);
      continue;
    }

    const sub = await call('POST', '/api/onboarding/submissions', {
      kind: 'DOCTOR',
      districtId: String(district._id),
      payload: {
        hospitalId: String(hospitalIds[d.clinic]),
        name: d.name, phone: d.phone, specialty: d.specialty,
        councilRegNo: d.reg, qualifications: d.quals, experienceYears: d.exp,
        fees: { fresh: d.fees[0], followup: d.fees[1], emergency: d.fees[2] },
      },
    });
    await call('POST', `/api/onboarding/submissions/${sub._id}/submit`);
    const out = await call('POST', `/api/admin/submissions/${sub._id}/approve`, { password: PASSWORD });
    const doctorId = out.doctor._id;

    // Link to the specialty master so the browse tiles find them.
    const specialtyId = specialtyBySlug.get(toSlug(d.specialty));
    if (specialtyId) await Doctor.updateOne({ _id: doctorId }, { $addToSet: { specialtyIds: specialtyId } });

    const pattern = PATTERNS[i % PATTERNS.length];
    await call('PUT', `/api/doctors/${doctorId}/schedule`, {
      schedule: pattern.days.map((day) => ({
        day, shift: pattern.shift, startTime: pattern.startTime, endTime: pattern.endTime, maxTokens: pattern.maxTokens,
      })),
    });

    // Open for bookings, or every card reads "Closed" and nothing is testable.
    await call('POST', `/api/queue/${doctorId}/booking`, { isOpen: true }).catch(() => {});

    let photoNote = 'no photo (initials)';
    if (d.photo) {
      try {
        await uploadPhoto(doctorId, d.photo);
        photoNote = `photo ${d.photo}`;
        withPhoto += 1;
      } catch (err) {
        photoNote = `photo FAILED (${err.message})`;
        withoutPhoto += 1;
      }
    } else {
      withoutPhoto += 1;
    }
    console.log(`  ${d.name.padEnd(24)} ${d.specialty.padEnd(17)} ${photoNote}`);
  }

  console.log(`\n${withPhoto} with photo, ${withoutPhoto} without — the initials fallback is exercised either way.`);
  console.log(`\nSearch from 22.8010, 88.3821 (Ichhapur Defence Estate) to see them.`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
