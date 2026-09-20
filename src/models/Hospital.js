import mongoose from 'mongoose';
import { NETWORK_STATE } from '../config/constants.js';
import { env } from '../config/env.js';

const hospitalSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    type: { type: String, enum: ['CLINIC', 'HOSPITAL', 'POLYCLINIC'], default: 'CLINIC' },
    licenseNumber: { type: String, required: true, trim: true },
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: 'District', required: true },

    address: {
      line1: { type: String, required: true },
      line2: String,
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
      formatted: String,
      placeId: String,
    },
    // GeoJSON: [longitude, latitude]. lng FIRST.
    location: {
      type: { type: String, enum: ['Point'], default: 'Point', required: true },
      coordinates: { type: [Number], required: true },
    },
    geocode: {
      source: { type: String, enum: ['GOOGLE', 'MANUAL'], default: 'MANUAL' },
      accuracy: String,
      geocodedAt: Date,
    },

    contactPhone: String,
    contactEmail: String,
    subscriptionPlan: { type: String, enum: ['FREE', 'BASIC', 'PRO', 'ENTERPRISE'], default: 'FREE' },
    subscriptionValidTill: Date,

    networkState: { type: String, enum: Object.values(NETWORK_STATE), default: NETWORK_STATE.PENDING_APPROVAL },
    stateHistory: [
      {
        from: String,
        to: String,
        reason: String,
        byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
      },
    ],
    suspendedAt: Date,
    suspendReason: String,
    deboardedAt: Date,
    deboardReason: String,

    // Per-hospital WABridge credentials. Top tier of the three-tier resolution
    // (hospital -> WaSettings -> env) so a clinic can send from its own number.
    waOverride: {
      appKey: { type: String, default: '' },
      authKey: { type: String, default: '', select: false },
      deviceId: { type: String, default: '' },
      baseUrl: { type: String, default: '' },
    },

    timezone: { type: String, default: () => env.DEFAULT_TIMEZONE },
    onboardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'OnboardingSubmission' },
  },
  { timestamps: true },
);

// Partial 2dsphere: nearby search only ever queries ACTIVE hospitals, so keeping
// the others out of the index makes the hot path index-only at no cost.
hospitalSchema.index(
  { location: '2dsphere' },
  { partialFilterExpression: { networkState: NETWORK_STATE.ACTIVE } },
);
// A second, full geo index for admin tooling that needs to locate non-active
// hospitals (the partial one above cannot serve those queries).
hospitalSchema.index({ location: '2dsphere' }, { name: 'location_2dsphere_all' });
hospitalSchema.index({ licenseNumber: 1 }, { unique: true });
hospitalSchema.index({ code: 1 }, { unique: true });
hospitalSchema.index({ networkState: 1, districtId: 1 });
hospitalSchema.index({ districtId: 1, name: 1 });

hospitalSchema.virtual('isBookable').get(function isBookable() {
  return this.networkState === NETWORK_STATE.ACTIVE;
});

export const Hospital = mongoose.model('Hospital', hospitalSchema);
