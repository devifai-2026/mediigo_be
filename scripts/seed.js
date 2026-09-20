/**
 * Idempotent seed. Upserts on natural keys, safe to re-run.
 *
 * The data is deliberately shaped to exercise edge cases on first boot:
 *  - one SUSPENDED hospital, so the nearby filter is provably doing something
 *  - one PENDING_APPROVAL hospital, so the approval queue is not empty
 *  - one doctor already on a break, so the break UI has state to render
 *  - a patient whose policies trigger ALL FOUR gap-engine rules
 *  - a mixed queue (completed / in-chamber / waiting / skipped) with split tenders
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/modules/auth/service.js';
import { aadhaarHash } from '../src/lib/crypto.js';
import { clinicDate, financialYear } from '../src/lib/dates.js';
import { formatReceipt } from '../src/lib/counters.js';
import {
  User, District, Hospital, Doctor, QRStandee, OPDToken, Transaction,
  PatientPolicy, OnboardingSubmission, WaSettings, Counter, syncAllIndexes,
} from '../src/models/index.js';
import { ROLES, NETWORK_STATE, TOKEN_STATUS, VISIT_TYPE, TOKEN_SOURCE, STANDEE_STATUS, SUBMISSION_STATUS, PLAN_TYPE } from '../src/config/constants.js';

const FORCE = process.argv.includes('--force');
const PASSWORD = 'Mediigo@123';

const upsert = async (Model, filter, doc) => {
  const res = await Model.findOneAndUpdate(filter, { $setOnInsert: doc }, { new: true, upsert: true });
  return res;
};

const run = async () => {
  if (env.NODE_ENV === 'production' && !FORCE) {
    logger.error('Refusing to seed in production without --force');
    process.exit(1);
  }

  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  logger.info('connected — seeding');

  const pwd = await hashPassword(PASSWORD);
  const today = clinicDate(env.DEFAULT_TIMEZONE);
  const fy = financialYear(today);

  // 1. WA settings singleton — console driver + demo OTP, so a fresh clone works.
  await WaSettings.findOneAndUpdate(
    { _id: 'singleton' },
    { $setOnInsert: { provider: 'console', enabled: false, otpDemo: true, otpDemoCode: '1234', require2faRoles: [] } },
    { upsert: true, new: true },
  );

  // 2. Districts. cityTier drives the policy benchmarks.
  const kol = await upsert(District, { code: 'WB-KOL' }, {
    name: 'Kolkata', code: 'WB-KOL', state: 'West Bengal', cityTier: 1,
    centroid: { type: 'Point', coordinates: [88.3639, 22.5726] },
  });
  const how = await upsert(District, { code: 'WB-HOW' }, {
    name: 'Howrah', code: 'WB-HOW', state: 'West Bengal', cityTier: 2,
    centroid: { type: 'Point', coordinates: [88.2636, 22.5958] },
  });
  await upsert(District, { code: 'WB-DGP' }, {
    name: 'Durgapur', code: 'WB-DGP', state: 'West Bengal', cityTier: 3,
    centroid: { type: 'Point', coordinates: [87.3119, 23.5204] },
  });

  // 3-5. Platform staff.
  const superAdmin = await upsert(User, { phone: '9000000001' }, {
    phone: '9000000001', name: 'Mediigo Super Admin', role: ROLES.SUPER_ADMIN, passwordHash: pwd,
    email: 'super@mediigo.com',
  });
  const execKol = await upsert(User, { phone: '9000000011' }, {
    phone: '9000000011', name: 'Ananya Das', role: ROLES.EXEC_ADMIN, passwordHash: pwd,
    email: 'kolkata.admin@mediigo.com', districtId: kol._id,
  });
  await upsert(User, { phone: '9000000012' }, {
    phone: '9000000012', name: 'Rahul Verma', role: ROLES.EXEC_ADMIN, passwordHash: pwd,
    email: 'howrah.admin@mediigo.com', districtId: how._id,
  });
  const agentKol = await upsert(User, { phone: '9000000021' }, {
    phone: '9000000021', name: 'Suresh Kumar', role: ROLES.FIELD_AGENT, passwordHash: pwd, districtId: kol._id,
  });
  const agentHow = await upsert(User, { phone: '9000000022' }, {
    phone: '9000000022', name: 'Meera Iyer', role: ROLES.FIELD_AGENT, passwordHash: pwd, districtId: how._id,
  });

  // 6. Hospitals with real coordinates around Kolkata.
  const mk = (code, name, line1, city, pincode, lng, lat, districtId, state, plan, license) => ({
    code, name, type: 'CLINIC', licenseNumber: license, districtId,
    address: { line1, city, state: 'West Bengal', pincode, formatted: `${line1}, ${city}, West Bengal ${pincode}` },
    location: { type: 'Point', coordinates: [lng, lat] },
    geocode: { source: 'MANUAL', accuracy: 'ROOFTOP', geocodedAt: new Date() },
    networkState: state, subscriptionPlan: plan, contactPhone: '03340001234',
    onboardedBy: agentKol._id, approvedBy: execKol._id,
  });

  const h1 = await upsert(Hospital, { code: 'MG-KOL-001' },
    mk('MG-KOL-001', 'Sunrise Multispeciality', 'DD-12, Sector 1, Salt Lake', 'Kolkata', '700064',
       88.4177, 22.5867, kol._id, NETWORK_STATE.ACTIVE, 'PRO', 'WB-CLIN-100001'));
  const h2 = await upsert(Hospital, { code: 'MG-KOL-002' },
    mk('MG-KOL-002', 'CareWell Polyclinic', '45A Gariahat Road', 'Kolkata', '700019',
       88.3673, 22.5186, kol._id, NETWORK_STATE.ACTIVE, 'BASIC', 'WB-CLIN-100002'));
  // Suspended: must NOT appear in nearby search.
  await upsert(Hospital, { code: 'MG-KOL-003' },
    mk('MG-KOL-003', 'Apex Clinic New Town', 'AA-II, New Town', 'Kolkata', '700156',
       88.4637, 22.5786, kol._id, NETWORK_STATE.SUSPENDED, 'BASIC', 'WB-CLIN-100003'));
  // Pending: drives the approvals queue.
  const h4 = await upsert(Hospital, { code: 'MG-HOW-001' },
    mk('MG-HOW-001', 'Ganga Nursing Home', '12 Foreshore Road', 'Howrah', '711101',
       88.3103, 22.5958, how._id, NETWORK_STATE.PENDING_APPROVAL, 'FREE', 'WB-CLIN-100004'));

  // 7. Doctors. One starts on a break so that UI has state on first render.
  const doctorSeeds = [
    { phone: '9000000101', name: 'Dr. Sandeep Dhore', specialty: 'General Medicine', reg: 'WBMC-55101', hospital: h1, chamber: '104', fees: { fresh: 400, followup: 200, emergency: 800 }, open: true, quals: ['MBBS', 'MD (Internal Medicine)'] },
    { phone: '9000000102', name: 'Dr. Ananya Roy', specialty: 'Cardiology', reg: 'WBMC-55102', hospital: h1, chamber: '201', fees: { fresh: 600, followup: 300, emergency: 1200 }, open: true, quals: ['MBBS', 'DM (Cardiology)'] },
    { phone: '9000000103', name: 'Dr. Vikram Joshi', specialty: 'Orthopedics', reg: 'WBMC-55103', hospital: h1, chamber: '105', fees: { fresh: 700, followup: 350, emergency: 1400 }, open: false, quals: ['MS (Orthopedics)'], onBreak: true },
    { phone: '9000000104', name: 'Dr. Priya Nair', specialty: 'Pediatrics', reg: 'WBMC-55104', hospital: h2, chamber: '01', fees: { fresh: 500, followup: 250, emergency: 1000 }, open: true, quals: ['MBBS', 'DCH'] },
    { phone: '9000000105', name: 'Dr. Sunita Rao', specialty: 'Dermatology', reg: 'WBMC-55105', hospital: h2, chamber: '02', fees: { fresh: 600, followup: 300, emergency: 1200 }, open: true, quals: ['MBBS', 'DDVL'] },
    { phone: '9000000106', name: 'Dr. Kavita Reddy', specialty: 'ENT', reg: 'WBMC-55106', hospital: h2, chamber: '03', fees: { fresh: 550, followup: 275, emergency: 1100 }, open: false, quals: ['MS (ENT)'] },
  ];

  const doctors = [];
  for (const d of doctorSeeds) {
    const u = await upsert(User, { phone: d.phone }, {
      phone: d.phone, name: d.name, role: ROLES.DOCTOR, passwordHash: pwd, hospitalId: d.hospital._id,
    });
    const doc = await upsert(Doctor, { councilRegNo: d.reg }, {
      userId: u._id, hospitalId: d.hospital._id, name: d.name, specialty: d.specialty,
      qualifications: d.quals, councilRegNo: d.reg, chamberNumber: d.chamber, fees: d.fees,
      experienceYears: 8,
      session: {
        isBookingOpen: d.open,
        isOnBreak: Boolean(d.onBreak),
        breakReason: d.onBreak ? 'Emergency' : null,
        breakUntil: d.onBreak ? new Date(Date.now() + 45 * 60_000) : null,
        lastCalledToken: 0,
      },
    });
    if (!u.doctorId) await User.updateOne({ _id: u._id }, { $set: { doctorId: doc._id } });
    doctors.push(doc);
  }

  // Re-running the seed restores the intended session state. upsert's
  // $setOnInsert never touches an existing doc, so without this an earlier
  // suspend/close would persist and leave the demo with no bookable doctor.
  for (const d of doctorSeeds) {
    await Doctor.updateOne(
      { councilRegNo: d.reg },
      {
        $set: {
          'session.isBookingOpen': d.open,
          'session.isOnBreak': Boolean(d.onBreak),
          'session.breakReason': d.onBreak ? 'Emergency' : null,
          'session.breakUntil': d.onBreak ? new Date(Date.now() + 45 * 60_000) : null,
        },
      },
    );
  }

  // 8. Receptionists.
  await upsert(User, { phone: '9000000031' }, {
    phone: '9000000031', name: 'Riya Sen', role: ROLES.RECEPTIONIST, passwordHash: pwd, hospitalId: h1._id,
  });
  await upsert(User, { phone: '9000000032' }, {
    phone: '9000000032', name: 'Arjun Ghosh', role: ROLES.RECEPTIONIST, passwordHash: pwd, hospitalId: h2._id,
  });

  // 9. Patients. OTP-only, no password.
  const rajesh = await upsert(User, { phone: '9876543210' }, {
    phone: '9876543210', name: 'Rajesh Kumar', role: ROLES.PATIENT,
    dob: new Date('1982-04-11'), gender: 'M',
    aadhaarHash: aadhaarHash('234123412346'),
    familyMembers: [
      { name: 'Rajesh Kumar', relation: 'SELF', dob: new Date('1982-04-11'), gender: 'M' },
      { name: 'Sunita Kumar', relation: 'SPOUSE', dob: new Date('1986-08-02'), gender: 'F' },
      { name: 'Aarav Kumar', relation: 'CHILD', dob: new Date('2016-01-20'), gender: 'M' },
    ],
  });
  const otherPatients = [];
  for (const [i, nm] of ['Priya Sharma', 'Amit Kumar', 'Sunita Devi', 'Rahul Verma'].entries()) {
    otherPatients.push(await upsert(User, { phone: `987654321${i + 1}` }, {
      phone: `987654321${i + 1}`, name: nm, role: ROLES.PATIENT, gender: i % 2 ? 'F' : 'M',
    }));
  }

  // 10. QR standees.
  for (let i = 1; i <= 10; i += 1) {
    const serial = `MG-STD-${String(i).padStart(6, '0')}`;
    const assigned = i <= 4 ? h1 : i <= 6 ? h2 : null;
    await upsert(QRStandee, { serialId: serial }, {
      serialId: serial, batchCode: 'BATCH-2026-A',
      hospitalId: assigned?._id ?? null,
      status: assigned ? STANDEE_STATUS.DEPLOYED : STANDEE_STATUS.UNASSIGNED,
      deployedAt: assigned ? new Date() : null,
      deployedBy: assigned ? agentKol._id : null,
    });
  }

  // 11. Today's queue for doctor 1 — a realistic mix, with matching transactions.
  const d1 = doctors[0];
  const existing = await OPDToken.countDocuments({ doctorId: d1._id, date: today });
  if (existing === 0) {
    const queue = [
      { n: 1, p: rajesh,            status: TOKEN_STATUS.COMPLETED,  visit: VISIT_TYPE.FRESH,     tender: { cash: 400, upi: 0, card: 0 } },
      { n: 2, p: otherPatients[0],  status: TOKEN_STATUS.COMPLETED,  visit: VISIT_TYPE.FOLLOWUP,  tender: { cash: 0, upi: 200, card: 0 } },
      { n: 3, p: otherPatients[1],  status: TOKEN_STATUS.IN_CHAMBER, visit: VISIT_TYPE.FRESH,     tender: { cash: 200, upi: 200, card: 0 } },
      { n: 4, p: otherPatients[2],  status: TOKEN_STATUS.SKIPPED,    visit: VISIT_TYPE.FRESH,     tender: { cash: 400, upi: 0, card: 0 } },
      { n: 5, p: otherPatients[3],  status: TOKEN_STATUS.WAITING,    visit: VISIT_TYPE.FRESH,     tender: { cash: 0, upi: 400, card: 0 } },
      { n: 6, p: rajesh,            status: TOKEN_STATUS.WAITING,    visit: VISIT_TYPE.FOLLOWUP,  tender: { cash: 200, upi: 0, card: 0 } },
      { n: 7, p: otherPatients[0],  status: TOKEN_STATUS.WAITING,    visit: VISIT_TYPE.FRESH,     tender: { cash: 0, upi: 0, card: 400 } },
      { n: 8, p: otherPatients[1],  status: TOKEN_STATUS.WAITING,    visit: VISIT_TYPE.FRESH,     tender: { cash: 400, upi: 0, card: 0 } },
    ];

    let receiptSeq = 0;
    for (const q of queue) {
      const fee = d1.fees[q.visit];
      const token = await OPDToken.create({
        tokenNumber: q.n, date: today, doctorId: d1._id, hospitalId: h1._id, patientId: q.p._id,
        patientSnapshot: { name: q.p.name, phone: q.p.phone, gender: q.p.gender },
        visitType: q.visit, source: TOKEN_SOURCE.WALKIN, status: q.status,
        statusHistory: [{ from: null, to: q.status, at: new Date() }],
        isPaid: true,
        completedAt: q.status === TOKEN_STATUS.COMPLETED ? new Date() : undefined,
        enteredChamberAt: q.status === TOKEN_STATUS.IN_CHAMBER ? new Date() : undefined,
        skippedAt: q.status === TOKEN_STATUS.SKIPPED ? new Date() : undefined,
        skipReason: q.status === TOKEN_STATUS.SKIPPED ? 'Patient not present' : undefined,
      });
      receiptSeq += 1;
      const txn = await Transaction.create({
        tokenId: token._id, hospitalId: h1._id, doctorId: d1._id, patientId: q.p._id, date: today,
        visitType: q.visit, baseFee: fee, discount: 0, totalFee: fee, tender: q.tender,
        receiptNumber: formatReceipt(env.RECEIPT_PREFIX, h1.code, fy, receiptSeq), receiptSeq, fy,
        collectedBy: superAdmin._id,
      });
      await OPDToken.updateOne({ _id: token._id }, { $set: { transactionId: txn._id } });
    }
    // Counters must match what we just inserted, or the next real walk-in collides.
    await Counter.findOneAndUpdate({ _id: `token:${d1._id}:${today}` }, { $set: { seq: queue.length } }, { upsert: true });
    await Counter.findOneAndUpdate({ _id: `receipt:${h1._id}:${fy}` }, { $set: { seq: receiptSeq } }, { upsert: true });
    await Doctor.updateOne({ _id: d1._id }, { $set: { 'session.lastCalledToken': 3 } });
  }

  // 12. Policies for Rajesh, shaped to trigger all four gap rules.
  const ah = aadhaarHash('234123412346');
  const policySeeds = [
    { policyNumber: 'STAR-IND-0001', insurerName: 'Star Health', planType: PLAN_TYPE.INDIVIDUAL, sumInsured: 200000, roomRentCapDaily: 2000, premiumAnnual: 9000 },
    { policyNumber: 'HDFC-IND-0002', insurerName: 'HDFC Ergo', planType: PLAN_TYPE.INDIVIDUAL, sumInsured: 150000, roomRentCapPct: 1, premiumAnnual: 7000 },
    { policyNumber: 'GRP-EMP-0003', insurerName: 'New India Assurance', planType: PLAN_TYPE.GROUP, sumInsured: 300000, copayPct: 20, premiumAnnual: 0 },
  ];
  for (const p of policySeeds) {
    await upsert(PatientPolicy, { policyNumber: p.policyNumber, insurerName: p.insurerName }, {
      ...p, patientId: rajesh._id, aadhaarHash: ah, holderName: rajesh.name,
      distributorName: 'Mediigo Partner Network', sourceDistrictId: kol._id,
      startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), isActive: true,
      membersCovered: [{ name: 'Rajesh Kumar', relation: 'SELF' }],
    });
  }

  // 13. A pending submission, with geocode prefilled so approval works with no Google key.
  await upsert(OnboardingSubmission, { 'payload.code': 'MG-HOW-001' }, {
    kind: 'HOSPITAL', agentId: agentHow._id, districtId: how._id, status: SUBMISSION_STATUS.SUBMITTED,
    payload: {
      code: 'MG-HOW-001', name: 'Ganga Nursing Home', licenseNumber: 'WB-CLIN-100004',
      address: { line1: '12 Foreshore Road', city: 'Howrah', state: 'West Bengal', pincode: '711101' },
      primaryContact: { name: 'Bimal Ganguly', phone: '9000000041' },
      subscriptionPlan: 'BASIC',
    },
    geocodeResult: { lat: 22.5958, lng: 88.3103, formatted: '12 Foreshore Road, Howrah', accuracy: 'ROOFTOP' },
  });

  // 14. Indexes last, so everything above exists when they build.
  const idx = await syncAllIndexes();
  const geo = idx.find((i) => i.model === 'Hospital');
  const tok = idx.find((i) => i.model === 'OPDToken');

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  MEDIIGO SEED COMPLETE');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  Clinic date: ${today}   Financial year: ${fy}`);
  console.log(`  Hospital indexes: ${geo?.indexes.join(', ')}`);
  console.log(`  OPDToken indexes: ${tok?.indexes.join(', ')}`);
  console.log('\n  LOGIN CREDENTIALS');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('  Role            Phone         Password / OTP');
  console.log('  Super Admin     9000000001    ' + PASSWORD);
  console.log('  Exec (Kolkata)  9000000011    ' + PASSWORD);
  console.log('  Exec (Howrah)   9000000012    ' + PASSWORD);
  console.log('  Field Agent     9000000021    ' + PASSWORD);
  console.log('  Doctor          9000000101    ' + PASSWORD + '   (Dr. Sandeep Dhore, Chamber 104)');
  console.log('  Receptionist    9000000031    ' + PASSWORD + '   (Sunrise Multispeciality)');
  console.log('  Patient         9876543210    OTP: 1234        (Rajesh Kumar, 3 policies)');
  console.log('─────────────────────────────────────────────────────────────\n');

  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error({ err }, 'seed failed');
  process.exit(1);
});
