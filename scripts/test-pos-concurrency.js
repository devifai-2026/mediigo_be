/**
 * The single most important test in this codebase.
 *
 * Fires N simultaneous walk-ins at ONE doctor and asserts the allocated token
 * numbers are exactly 1..N — no gaps, no duplicates. A gap means a burned
 * sequence (a patient's paper token skips a number); a duplicate means two
 * patients are told they are the same token, which is unrecoverable at a desk.
 *
 * Also verifies every resulting transaction's tender sums exactly to its fee.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Doctor, OPDToken, Transaction, User, Counter, Hospital } from '../src/models/index.js';
import { createWalkin } from '../src/modules/pos/service.js';
import { clinicDate } from '../src/lib/dates.js';
import { ROLES } from '../src/config/constants.js';

const N = Number(process.argv[2] || 20);

const run = async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });

  // Use the ENT doctor (no seeded queue) and open bookings for the test.
  const doctor = await Doctor.findOne({ councilRegNo: 'WBMC-55106' });
  const hospital = await Hospital.findById(doctor.hospitalId).lean();
  const receptionist = await User.findOne({ role: ROLES.RECEPTIONIST, hospitalId: hospital._id }).lean();
  const date = clinicDate(hospital.timezone);

  // Clean slate for a repeatable run.
  const old = await OPDToken.find({ doctorId: doctor._id, date }).select('_id').lean();
  await Transaction.deleteMany({ tokenId: { $in: old.map((o) => o._id) } });
  await OPDToken.deleteMany({ doctorId: doctor._id, date });
  await Counter.deleteOne({ _id: `token:${doctor._id}:${date}` });
  await Doctor.updateOne({ _id: doctor._id }, { $set: { 'session.isBookingOpen': true } });

  const actor = { id: String(receptionist._id), role: ROLES.RECEPTIONIST, hospitalId: String(hospital._id) };
  const fee = doctor.fees.fresh;

  console.log(`\nFiring ${N} SIMULTANEOUS walk-ins at ${doctor.name} (fee ₹${fee}, date ${date})...\n`);
  const started = Date.now();

  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      createWalkin({
        body: {
          doctorId: String(doctor._id),
          patient: { name: `Concurrent Patient ${i + 1}`, phone: `90000${String(70000 + i)}`, gender: 'M' },
          visitType: 'fresh',
          discount: 0,
          // Alternate pure-cash and a genuine split, so the tender assertion is
          // exercised both ways under contention.
          tender: i % 2 === 0 ? { cash: fee, upi: 0, card: 0 } : { cash: fee - 100, upi: 100, card: 0 },
        },
        actor,
      }),
    ),
  );

  const elapsed = Date.now() - started;
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  const numbers = ok.map((r) => r.value.token.tokenNumber).sort((a, b) => a - b);
  const expected = Array.from({ length: N }, (_, i) => i + 1);
  const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  const gaps = expected.filter((n) => !numbers.includes(n));

  const txns = await Transaction.find({ doctorId: doctor._id, date }).lean();
  const imbalanced = txns.filter(
    (t) => Math.round((t.tender.cash + t.tender.upi + t.tender.card) * 100) !== Math.round(t.totalFee * 100),
  );
  const receipts = txns.map((t) => t.receiptNumber);
  const dupeReceipts = receipts.filter((r, i) => receipts.indexOf(r) !== i);

  console.log(`  elapsed:            ${elapsed}ms`);
  console.log(`  succeeded:          ${ok.length}/${N}`);
  console.log(`  failed:             ${failed.length}`);
  if (failed.length) failed.slice(0, 3).forEach((f) => console.log(`     ! ${f.reason?.message}`));
  console.log(`  token numbers:      ${numbers.join(',')}`);
  console.log(`  duplicates:         ${duplicates.length ? duplicates.join(',') : 'NONE'}`);
  console.log(`  gaps:               ${gaps.length ? gaps.join(',') : 'NONE'}`);
  console.log(`  transactions:       ${txns.length}`);
  console.log(`  tender imbalances:  ${imbalanced.length}`);
  console.log(`  duplicate receipts: ${dupeReceipts.length ? dupeReceipts.join(',') : 'NONE'}`);

  const pass =
    ok.length === N && duplicates.length === 0 && gaps.length === 0 &&
    imbalanced.length === 0 && dupeReceipts.length === 0 && txns.length === N;

  console.log(`\n  ${pass ? 'PASS — sequential, gapless, balanced' : 'FAIL'}\n`);

  // Leave the DB as we found it.
  const created = await OPDToken.find({ doctorId: doctor._id, date }).select('_id patientId').lean();
  await Transaction.deleteMany({ tokenId: { $in: created.map((c) => c._id) } });
  await OPDToken.deleteMany({ doctorId: doctor._id, date });
  await User.deleteMany({ name: /^Concurrent Patient / });
  await Counter.deleteOne({ _id: `token:${doctor._id}:${date}` });
  await Doctor.updateOne({ _id: doctor._id }, { $set: { 'session.isBookingOpen': false } });

  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
};

run().catch((err) => { console.error(err); process.exit(1); });
