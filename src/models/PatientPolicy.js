import mongoose from 'mongoose';
import { PLAN_TYPE } from '../config/constants.js';

const patientPolicySchema = new mongoose.Schema(
  {
    // Nullable by design: a field agent scans Aadhaar at a camp before the
    // patient has ever registered. aadhaarHash is the real join key and
    // patientId is backfilled when they sign up.
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    aadhaarHash: { type: String, required: true },
    holderName: String,

    distributorName: String,
    insurerName: { type: String, required: true },
    policyNumber: { type: String, required: true, trim: true },
    planType: { type: String, enum: Object.values(PLAN_TYPE), required: true },

    sumInsured: { type: Number, required: true, min: 0 },
    deductible: { type: Number, default: 0 },
    // null means NO cap, which is the best case. Do not default this to 0.
    roomRentCapDaily: { type: Number, default: null },
    roomRentCapPct: { type: Number, default: null },
    icuCapDaily: { type: Number, default: null },
    copayPct: { type: Number, default: 0 },

    riders: { type: [String], default: [] },
    membersCovered: [
      { name: String, relation: String, dob: Date, aadhaarHash: String },
    ],

    startDate: Date,
    endDate: Date,
    premiumAnnual: Number,
    isActive: { type: Boolean, default: true },
    sourceDistrictId: { type: mongoose.Schema.Types.ObjectId, ref: 'District' },
    capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

patientPolicySchema.index({ aadhaarHash: 1, isActive: 1 });
patientPolicySchema.index({ patientId: 1, isActive: 1 });
patientPolicySchema.index({ policyNumber: 1, insurerName: 1 }, { unique: true });

export const PatientPolicy = mongoose.model('PatientPolicy', patientPolicySchema);
