/**
 * Seed platform billing defaults.
 *
 * Idempotent: re-running will not overwrite rates an admin has since changed.
 * Pass --force to reset everything back to the documented defaults.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { BillingSettings } from '../src/models/index.js';

const DEFAULTS = {
  _id: 'singleton',
  onlineRatePaise: 1000, // ₹10 — patient booked it themselves (app or QR)
  offlineRatePaise: 100, // ₹1  — clinic staff keyed it in (walk-in or phone)
  chargeMode: 'RUPEES',
  percentBps: 0,
  maxTrialDays: 90,
  defaultTrialDays: 30,
  maxMonthlyChargePaise: 0, // 0 = uncapped until an admin sets a ceiling
  arrearsFlagPaise: 500000, // ₹5,000
};

const force = process.argv.includes('--force');

const run = async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  const existing = await BillingSettings.findById('singleton');

  if (existing && !force) {
    console.log('Billing settings already present — leaving them alone. Use --force to reset.');
    console.log(`  online ₹${existing.onlineRatePaise / 100} · offline ₹${existing.offlineRatePaise / 100} · max trial ${existing.maxTrialDays}d`);
  } else {
    await BillingSettings.findByIdAndUpdate('singleton', DEFAULTS, { upsert: true, new: true, setDefaultsOnInsert: true });
    console.log(force && existing ? 'Billing settings RESET to defaults:' : 'Billing settings seeded:');
    console.log(`  online ₹${DEFAULTS.onlineRatePaise / 100} (APP, QR_SCAN)`);
    console.log(`  offline ₹${DEFAULTS.offlineRatePaise / 100} (WALKIN, PHONE)`);
    console.log(`  trial: ${DEFAULTS.defaultTrialDays}d default, ${DEFAULTS.maxTrialDays}d max`);
    console.log(`  arrears flag: ₹${DEFAULTS.arrearsFlagPaise / 100}`);
  }
  await mongoose.disconnect();
};

run().catch((e) => { console.error(e); process.exit(1); });
