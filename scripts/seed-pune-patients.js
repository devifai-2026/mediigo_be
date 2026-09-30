/**
 * Second half of the Pune seed: patients, their family members, and the
 * consultation history behind them.
 *
 * Today's queues are booked through the real API, so token numbers come from
 * the same counter the front desk uses and the live board is genuinely
 * consistent. Historical days cannot be: the booking endpoint refuses a past
 * date, by design. Those are written with the models, at the same shape the
 * API would have produced — including the receipt sequence, which has to stay
 * contiguous per clinic and financial year or the day-close numbers stop
 * reconciling.
 *
 * History runs from 4 September to today, so the charts have a real curve
 * rather than a single spike.
 */
import {
  User, Doctor, Hospital, OPDToken, Transaction, Counter,
} from '../src/models/index.js';
import { hashPassword } from '../src/modules/auth/service.js';
import { clinicDate, financialYear } from '../src/lib/dates.js';
import { formatReceipt } from '../src/lib/counters.js';
import { env } from '../src/config/env.js';
import {
  ROLES, TOKEN_STATUS, VISIT_TYPE, TOKEN_SOURCE,
} from '../src/config/constants.js';

const log = (...a) => console.log(...a);
const pad = (n, w = 2) => String(n).padStart(w, '0');
const pick = (arr, i) => arr[i % arr.length];

const HISTORY_START = '2026-09-04';

const P_FIRST = ['Rajesh', 'Priya', 'Amol', 'Sonali', 'Mahesh', 'Rutuja', 'Sachin', 'Aarti', 'Nitin', 'Pallavi',
  'Kiran', 'Deepa', 'Santosh', 'Vrushali', 'Ajay', 'Manisha', 'Ravi', 'Shalini', 'Hemant', 'Bhakti',
  'Anand', 'Sayali', 'Vishal', 'Ketaki', 'Prasad', 'Mrunal', 'Dattatray', 'Ashwini', 'Rohan', 'Sarika',
  'Nandini', 'Umesh', 'Gauri', 'Sandeep', 'Rekha', 'Bhushan', 'Vidya', 'Mangesh', 'Snehal', 'Arun',
  'Komal', 'Suhas', 'Meenal', 'Ganesh', 'Supriya', 'Vinay', 'Jayshree', 'Prathamesh', 'Leena', 'Milind',
  'Radhika', 'Tejas', 'Anuja', 'Sagar', 'Poonam', 'Nilesh', 'Varsha', 'Ketan', 'Madhura', 'Yash'];
const P_LAST = ['Kulkarni', 'Deshpande', 'Patil', 'Joshi', 'Jadhav', 'Pawar', 'Shinde', 'Bhosale', 'Sawant',
  'Kadam', 'Chavan', 'More', 'Gaikwad', 'Salunkhe', 'Thorat'];

const dateStrings = (from, to) => {
  const out = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const cur = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
};

const dayOfWeek = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
};

export const seedPatientsAndQueues = async ({ doctors, hospitals, call, patientLogin }) => {
  const today = clinicDate(env.DEFAULT_TIMEZONE);

  // ---- patients -----------------------------------------------------------
  // No signup endpoint that sets a profile in one call, so the accounts are
  // written directly; they then authenticate over the API to book.
  log('\npatients');
  const pwd = await hashPassword('Mediigo@123');
  const patients = [];
  for (let i = 0; i < 60; i += 1) {
    const name = `${pick(P_FIRST, i)} ${pick(P_LAST, i * 3)}`;
    // Keeps the two documented demo logins working.
    const phone = i === 0 ? '9876543210' : i === 1 ? '9876543211' : `98765${pad(43212 + i, 5)}`;
    const gender = i % 2 === 0 ? 'M' : 'F';
    const birthYear = 1955 + ((i * 7) % 55);

    const family = [];
    if (i % 3 === 0) {
      family.push({
        name: `${pick(P_FIRST, i + 20)} ${pick(P_LAST, i * 3)}`,
        relation: 'SPOUSE', gender: gender === 'M' ? 'F' : 'M',
        dob: new Date(`${birthYear + 2}-0${(i % 9) + 1}-1${i % 9}`),
      });
    }
    if (i % 4 === 0) {
      family.push({
        name: `${pick(P_FIRST, i + 35)} ${pick(P_LAST, i * 3)}`,
        relation: 'CHILD', gender: i % 8 === 0 ? 'M' : 'F',
        dob: new Date(`${2012 + (i % 10)}-0${(i % 9) + 1}-0${(i % 8) + 1}`),
      });
    }

    const u = await User.findOneAndUpdate(
      { phone },
      {
        $set: {
          phone, name, role: ROLES.PATIENT, gender,
          dob: new Date(`${birthYear}-0${(i % 9) + 1}-1${i % 9}`),
          familyMembers: family, isActive: true, passwordHash: pwd,
        },
      },
      { upsert: true, new: true },
    );
    patients.push(u);
  }
  log(`  ${patients.length} patients (demo logins 9876543210 / 9876543211 preserved)`);

  // ---- history: 4 Sept → yesterday ---------------------------------------
  // Written with the models because the booking API refuses a past date. The
  // receipt sequence is advanced through the same counter the POS uses, so a
  // clinic's numbering stays contiguous and day-close still reconciles.
  const days = dateStrings(HISTORY_START, today);
  const past = days.filter((d) => d !== today);
  log(`\nhistory ${HISTORY_START} → ${past[past.length - 1]} (${past.length} days)`);

  const docsBy = await Doctor.find({}).lean();
  const hospBy = new Map((await Hospital.find({}).lean()).map((h) => [String(h._id), h]));
  const VISITS = [VISIT_TYPE.FRESH, VISIT_TYPE.FRESH, VISIT_TYPE.FRESH, VISIT_TYPE.FOLLOWUP, VISIT_TYPE.FOLLOWUP, VISIT_TYPE.EMERGENCY];

  let madeTokens = 0;
  let madeTxns = 0;
  let seq = 0;

  for (const date of past) {
    const dow = dayOfWeek(date);
    for (const doc of docsBy) {
      const sittings = (doc.schedule || []).filter((s) => s.day === dow && s.isActive !== false);
      if (!sittings.length) continue;

      for (const sit of sittings) {
        // Fewer patients at the weekend, more midweek — a flat line looks fake.
        const base = dow === 0 || dow === 6 ? 3 : 6;
        const count = base + ((seq + doc.name.length) % 5);
        const hosp = hospBy.get(String(doc.hospitalId));
        const fy = financialYear(date);

        for (let t = 1; t <= count; t += 1) {
          seq += 1;
          const p = patients[(seq * 7) % patients.length];
          const visitType = pick(VISITS, seq);
          // Most are seen; a few are skipped. Nothing is left WAITING on a past
          // day — a queue that never closed would be a data bug, not history.
          const skipped = seq % 11 === 0;
          const status = skipped ? TOKEN_STATUS.SKIPPED : TOKEN_STATUS.COMPLETED;
          const fee = doc.fees?.[visitType] ?? 500;
          const paid = !skipped;

          const [tok] = await OPDToken.create([{
            tokenNumber: t, date, shift: sit.shift || 'MORNING',
            startTime: sit.startTime, endTime: sit.endTime,
            doctorId: doc._id, hospitalId: doc.hospitalId, patientId: p._id,
            patientSnapshot: {
              name: p.name, phone: p.phone, gender: p.gender,
              age: p.dob ? Math.floor((Date.now() - new Date(p.dob).getTime()) / 31557600000) : null,
              complaint: seq % 4 === 0 ? pick(
                ['Fever and body ache', 'Follow-up on blood pressure', 'Persistent cough', 'Knee pain', 'Skin rash'],
                seq,
              ) : '',
            },
            visitType,
            source: seq % 5 === 0 ? TOKEN_SOURCE.WALKIN : TOKEN_SOURCE.APP,
            status,
            statusHistory: [{ from: null, to: TOKEN_STATUS.WAITING, at: new Date(`${date}T04:00:00Z`) }],
            completedAt: skipped ? undefined : new Date(`${date}T06:00:00Z`),
            skippedAt: skipped ? new Date(`${date}T06:00:00Z`) : undefined,
            skipReason: skipped ? 'Did not respond when called' : undefined,
            isPaid: paid,
          }]);
          madeTokens += 1;

          if (paid) {
            const rseq = await Counter.findOneAndUpdate(
              { _id: `receipt:${doc.hospitalId}:${fy}` },
              { $inc: { seq: 1 } },
              { upsert: true, new: true },
            );
            // Split tender across cash / UPI / card so the payment-mix charts
            // and the day-close breakdown have something real to show.
            const mode = seq % 3;
            const tender = mode === 0 ? { cash: fee, upi: 0, card: 0 }
              : mode === 1 ? { cash: 0, upi: fee, card: 0 }
                : { cash: Math.round(fee / 2), upi: fee - Math.round(fee / 2), card: 0 };

            const txn = await Transaction.create({
              tokenId: tok._id, hospitalId: doc.hospitalId, doctorId: doc._id, patientId: p._id,
              date, visitType, baseFee: fee, discount: 0, totalFee: fee, tender,
              receiptNumber: formatReceipt(env.RECEIPT_PREFIX, hosp?.code ?? 'MG', fy, rseq.seq),
              receiptSeq: rseq.seq, fy,
              collectedBy: p._id, status: 'PAID',
            });
            await OPDToken.updateOne({ _id: tok._id }, { $set: { transactionId: txn._id } });
            madeTxns += 1;
          }
        }

        // Keep the live counter in step with what history already used, or the
        // next real booking would collide on the unique index.
        await Counter.findOneAndUpdate(
          { _id: `token:${doc._id}:${date}:${sit.shift || 'MORNING'}` },
          { $set: { seq: count } },
          { upsert: true },
        );
      }
    }
  }
  log(`  ${madeTokens} consultations · ${madeTxns} payments`);

  // ---- today and the days ahead: booked through the real API --------------
  log('\ntoday + upcoming (booked via the API)');
  let live = 0;
  let ahead = 0;
  for (let i = 0; i < 24; i += 1) {
    const p = patients[(i * 5) % patients.length];
    const doc = docsBy[i % docsBy.length];
    try {
      const token = await patientLogin(p.phone, p.name);
      const avail = await call('GET', `/api/doctors/${doc._id}/availability`, null, token);
      const openDay = avail.days.find((d) => d.shifts.some((s) => s.isBookable));
      if (!openDay) continue;
      const shift = openDay.shifts.find((s) => s.isBookable);

      await call('POST', '/api/queue/book', {
        doctorId: String(doc._id),
        date: openDay.date,
        shift: shift.shift,
        visitType: pick(VISITS, i),
        ...(i % 3 === 0 ? { complaint: pick(['Fever since two days', 'Routine follow-up', 'Chest discomfort', 'Recurring headache'], i) } : {}),
      }, token);

      if (openDay.date === today) live += 1; else ahead += 1;
    } catch (e) {
      // A doctor whose sittings have all ended today is expected, not an error.
      if (!/ended|not sitting|fully booked/i.test(e.message)) log(`    ${doc.name}: ${e.message}`);
    }
  }
  log(`  ${live} in today's live queues · ${ahead} booked in the days ahead`);

  // ---- move a few of today's through the queue, so boards are not all WAITING
  const todays = await OPDToken.find({ date: today, status: TOKEN_STATUS.WAITING }).limit(8);
  let advanced = 0;
  for (const t of todays) {
    if (advanced >= 5) break;
    const to = advanced < 2 ? TOKEN_STATUS.COMPLETED : advanced < 3 ? TOKEN_STATUS.IN_CHAMBER : TOKEN_STATUS.WAITING;
    if (to === TOKEN_STATUS.WAITING) { advanced += 1; continue; }
    // One IN_CHAMBER per doctor per day is enforced by a unique index, so a
    // clash here is the guard doing its job rather than a failure.
    try {
      t.status = to;
      t.statusHistory.push({ from: TOKEN_STATUS.WAITING, to, at: new Date() });
      if (to === TOKEN_STATUS.COMPLETED) t.completedAt = new Date();
      await t.save();
      advanced += 1;
    } catch { advanced += 1; }
  }
  log(`  advanced ${advanced} of today's tokens into chamber/completed`);
};
