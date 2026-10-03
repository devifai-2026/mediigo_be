import mongoose from 'mongoose';

/**
 * Platform billing configuration, editable by Super Admin.
 *
 * Singleton, following the WaSettings pattern: one document, fixed _id, so a
 * read is a primary-key lookup and there is no "which row is current" question.
 *
 * Rates are stored in PAISE, not rupees. Every money comparison in this
 * codebase happens in integer paise (see lib/money.js) because comparing rupee
 * floats is how a silent ₹0.01 drift gets into a ledger nobody can reconcile.
 */
const billingSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'singleton' },

    /**
     * Per-token platform charge, by how the token was booked.
     *
     * Online means the patient did it themselves on a screen — the app, or
     * scanning the clinic's QR standee with their own phone. Offline means
     * clinic staff keyed it in at the desk, whether the patient walked up or
     * called. The gap in price reflects that the online ones are the bookings
     * Mediigo actually originates.
     */
    onlineRatePaise: { type: Number, default: 1000, min: 0 }, // ₹10
    offlineRatePaise: { type: Number, default: 100, min: 0 }, // ₹1

    /**
     * How a charge is derived. RUPEES is the flat per-token rate above.
     * PERCENT takes a cut of the consultation fee instead. CUSTOM means the
     * per-tenant override is authoritative and the global rate is ignored.
     */
    chargeMode: { type: String, enum: ['RUPEES', 'PERCENT', 'CUSTOM'], default: 'RUPEES' },
    // Basis points (1/100th of a percent) so 2.5% is 250 and stays an integer.
    percentBps: { type: Number, default: 0, min: 0, max: 10000 },

    /**
     * The longest trial anyone may grant. A District Admin picks a length for
     * the clinics they approve; this is the ceiling they cannot exceed, and
     * only Super Admin can move it.
     */
    maxTrialDays: { type: Number, default: 90, min: 0 },
    defaultTrialDays: { type: Number, default: 30, min: 0 },

    /**
     * Safety rail on the whole scheme. No single clinic can be charged more
     * than this in one billing month, whatever the rates or overrides say — a
     * fat-fingered rate change should not invoice someone for a lakh.
     * Zero means no cap.
     */
    maxMonthlyChargePaise: { type: Number, default: 0, min: 0 },

    // Unpaid balance above which a clinic is surfaced to Super Admin. Flagging
    // only — nothing about the clinic's service changes. See BillingCharge.
    arrearsFlagPaise: { type: Number, default: 500000, min: 0 }, // ₹5,000

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export const BillingSettings = mongoose.model('BillingSettings', billingSettingsSchema);

/** Read-through with creation, so a fresh install has defaults without a seed step. */
export const getBillingSettings = async () => {
  const existing = await BillingSettings.findById('singleton');
  if (existing) return existing;
  return BillingSettings.create({ _id: 'singleton' });
};
