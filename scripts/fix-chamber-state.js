/**
 * Repairs chamber state and installs the invariant that protects it.
 *
 * Two problems this fixes, both of which showed a doctor the wrong thing:
 *
 *   1. session.lastCalledToken carries no date, so yesterday's last call was
 *      rendered above today's empty queue as "Now consulting #03".
 *   2. Two tokens could sit at IN_CHAMBER for the same doctor and day, which
 *      is not a state a physical chamber can be in.
 *
 * Idempotent: safe to run more than once, and a no-op once clean.
 *
 *   node scripts/fix-chamber-state.js          # report only
 *   node scripts/fix-chamber-state.js --apply  # write
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { clinicDate } from '../src/lib/dates.js';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const log = (...a) => console.log(...a);

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || 'mediigo' });
  const db = mongoose.connection.db;
  const tokens = db.collection('opdtokens');
  const doctors = db.collection('doctors');
  const today = clinicDate();

  log(`\nchamber state repair — ${APPLY ? 'APPLY' : 'dry run'} (today ${today})\n`);

  // ---- 1. One IN_CHAMBER per doctor per day -------------------------------
  // The highest token number is the most recent call, so that one stays live
  // and anything earlier is treated as a consultation that already ended.
  const dupes = await tokens.aggregate([
    { $match: { status: 'IN_CHAMBER' } },
    { $group: { _id: { doctorId: '$doctorId', date: '$date' }, n: { $sum: 1 }, rows: { $push: { id: '$_id', tn: '$tokenNumber' } } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();

  log(`duplicate IN_CHAMBER groups: ${dupes.length}`);
  for (const g of dupes) {
    const sorted = g.rows.sort((a, b) => a.tn - b.tn);
    const keep = sorted.pop();
    for (const stale of sorted) {
      log(`  ${g._id.date} #${stale.tn} -> COMPLETED (keeping #${keep.tn})`);
      if (APPLY) {
        await tokens.updateOne({ _id: stale.id }, { $set: { status: 'COMPLETED', completedAt: new Date() } });
      }
    }
  }

  // ---- 2. Stale lastCalledToken -------------------------------------------
  // buildQueueSnapshot already ignores a value that names no token today, but
  // leaving it stored invites the same bug in the next thing that reads it.
  let stale = 0;
  for (const d of await doctors.find({}).project({ name: 1, session: 1 }).toArray()) {
    const lct = d.session?.lastCalledToken ?? 0;
    if (!lct) continue;
    if (await tokens.countDocuments({ doctorId: d._id, date: today, tokenNumber: lct })) continue;
    stale += 1;
    log(`  ${d.name}: lastCalledToken ${lct} -> 0`);
    if (APPLY) {
      await doctors.updateOne({ _id: d._id }, { $set: { 'session.lastCalledToken': 0, 'session.currentTokenId': null } });
    }
  }
  log(`stale lastCalledToken: ${stale}`);

  // ---- 3. Make it unrepeatable --------------------------------------------
  // A partial unique index, so only IN_CHAMBER rows are constrained: any number
  // of WAITING or COMPLETED tokens per doctor/day stay legal. This build fails
  // if duplicates remain, which is why it runs last.
  if (APPLY) {
    try {
      await tokens.createIndex(
        { doctorId: 1, date: 1 },
        { unique: true, partialFilterExpression: { status: 'IN_CHAMBER' }, name: 'one_in_chamber_per_doctor_per_day' },
      );
      log('index one_in_chamber_per_doctor_per_day: ok');
    } catch (e) {
      log(`index FAILED: ${e.message}`);
      log('(resolve the duplicates above, then re-run)');
    }
  } else {
    log('index one_in_chamber_per_doctor_per_day: would create');
  }

  log(APPLY ? '\ndone\n' : '\ndry run — re-run with --apply to write\n');
  await mongoose.disconnect();
};

run().catch((e) => { console.error(e); process.exit(1); });
