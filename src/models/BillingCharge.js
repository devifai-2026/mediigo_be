import mongoose from 'mongoose';
import { TOKEN_SOURCE } from '../config/constants.js';

/**
 * One platform charge against one clinic, for one token.
 *
 * Written when the token is created, not computed later from a rate table.
 * That matters: rates change, and a charge recomputed under today's rate would
 * silently rewrite what a clinic owed last month. The rate in force is frozen
 * onto the row, so the ledger stays true to what was actually agreed at the
 * moment the service was rendered.
 *
 * Nothing here gates service. A clinic in arrears keeps working exactly as
 * before; these rows feed reporting and collection, never an access check.
 */
const billingChargeSchema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'OPDToken', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },

    // Clinic-local date (YYYY-MM-DD) and month (YYYY-MM), matching how every
    // other aggregate in this codebase buckets time. A clinic's day ends on its
    // own timezone, not UTC.
    date: { type: String, required: true },
    month: { type: String, required: true },

    source: { type: String, enum: Object.values(TOKEN_SOURCE), required: true },
    // Denormalised so a ledger row explains itself without joining settings.
    channel: { type: String, enum: ['ONLINE', 'OFFLINE'], required: true },

    // What was charged, and the rule that produced it — both frozen.
    amountPaise: { type: Number, required: true, min: 0 },
    chargeMode: { type: String, enum: ['RUPEES', 'PERCENT', 'CUSTOM'], required: true },
    rateAppliedPaise: { type: Number, default: 0, min: 0 },
    percentBpsApplied: { type: Number, default: 0, min: 0 },
    // Set when the monthly cap clipped this row, so a sudden drop in billing is
    // explainable rather than looking like lost data.
    cappedBy: { type: String, enum: [null, 'MONTHLY_CAP'], default: null },

    status: { type: String, enum: ['ACCRUED', 'WAIVED', 'SETTLED'], default: 'ACCRUED' },
    waivedReason: { type: String, default: null },
    settledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One charge per token, enforced by the database rather than by trusting the
// caller. A retry or a double-tap must never bill a clinic twice.
billingChargeSchema.index({ tokenId: 1 }, { unique: true });
billingChargeSchema.index({ hospitalId: 1, month: 1 });
billingChargeSchema.index({ hospitalId: 1, status: 1 });
billingChargeSchema.index({ month: 1, status: 1 });

export const BillingCharge = mongoose.model('BillingCharge', billingChargeSchema);
