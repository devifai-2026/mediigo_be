import mongoose from 'mongoose';

/**
 * Online booking fee and the Cashfree credentials that collect it. Editable by
 * Super Admin only.
 *
 * Singleton, following the WaSettings / BillingSettings pattern.
 *
 * Both environments' keys are kept side by side so switching between sandbox
 * and live is one toggle, not a re-paste. Credentials are ENCRYPTED, never
 * plaintext (lib/secretBox.js), and select:false so an ordinary read of this
 * document can never carry them out to a browser by accident. Only the last
 * four characters of the app id are kept readable, so the admin can see which
 * key is saved.
 */
const credsSchema = new mongoose.Schema(
  {
    appIdEnc: { type: String, default: '', select: false },
    secretKeyEnc: { type: String, default: '', select: false },
    appIdHint: { type: String, default: '' },
    secretKeySet: { type: Boolean, default: false },
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const paymentSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'singleton' },

    // Off means booking stays free and nothing touches Cashfree.
    enabled: { type: Boolean, default: false },
    // Which key set is used for new orders. Orders remember their own mode,
    // so flipping this never breaks one already in progress.
    mode: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },

    // What a patient pays Mediigo to book online, in PAISE (₹10 default).
    // Separate from the consultation fee, which is still paid at the clinic.
    bookingFeePaise: { type: Number, default: 1000, min: 100 },

    sandbox: { type: credsSchema, default: () => ({}) },
    production: { type: credsSchema, default: () => ({}) },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false, _id: false },
);

export const PaymentSettings = mongoose.model('PaymentSettings', paymentSettingsSchema);
