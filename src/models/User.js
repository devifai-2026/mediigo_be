import mongoose from 'mongoose';
import { ROLES } from '../config/constants.js';

const familyMemberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    relation: { type: String, enum: ['SELF', 'SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER'], default: 'OTHER' },
    dob: Date,
    gender: { type: String, enum: ['M', 'F', 'O'] },
    aadhaarHash: { type: String, default: null },
    phone: String,
  },
  { _id: true, timestamps: false },
);

const userSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true, default: null },
    role: { type: String, enum: Object.values(ROLES), required: true },

    aadhaarHash: { type: String, default: null },
    dob: Date,
    gender: { type: String, enum: ['M', 'F', 'O'] },
    familyMembers: { type: [familyMemberSchema], default: [] },

    // Staff only. Patients are OTP-only and never receive one.
    passwordHash: { type: String, default: null, select: false },
    // Per-user override of the role-level 2FA policy set by Super Admin.
    twoFactorEnabled: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },

    // Scope anchors — the entire RBAC scope system reads these, and they are
    // copied into the JWT so scope checks cost no DB reads.
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: 'District', default: null },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },

    /**
     * Where the patient last told us they are, so a returning visit ranks
     * clinics by real distance instead of silently measuring from a hardcoded
     * city centre. Captured with permission, shown on their profile, and
     * editable there — never inferred behind their back.
     */
    // `default: undefined` on every field AND on the sub-document itself: with
    // per-field defaults alone, Mongoose materialises {label:'',accuracy:null}
    // for a user who has never shared a location, and the 2dsphere index
    // rejects that as "unknown GeoJSON type". The whole object must be absent.
    lastKnownLocation: {
      type: new mongoose.Schema(
        {
          type: { type: String, enum: ['Point'], required: true },
          coordinates: { type: [Number], required: true }, // [lng, lat]
          label: { type: String, default: '' },
          // The full postal string from reverse geocoding, so the patient can
          // confirm we have the right place rather than trusting two numbers.
          formatted: { type: String, default: '' },
          accuracy: { type: Number, default: null },
          updatedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: undefined,
    },

    lastLoginAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

userSchema.index({ phone: 1 }, { unique: true });
// One Aadhaar is one human — but only enforced for PATIENT primaries. A family
// member may later register in their own right, and blocking that is a support
// nightmare, so the subdoc index below is deliberately non-unique.
userSchema.index(
  { aadhaarHash: 1 },
  { unique: true, partialFilterExpression: { aadhaarHash: { $type: 'string' }, role: ROLES.PATIENT } },
);
userSchema.index({ role: 1, hospitalId: 1 });
userSchema.index({ role: 1, districtId: 1 });
userSchema.index({ 'familyMembers.aadhaarHash': 1 }, { sparse: true });
userSchema.index({ lastKnownLocation: '2dsphere' }, { sparse: true });

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const o = this.toObject({ virtuals: true });
  delete o.passwordHash;
  return o;
};

export const User = mongoose.model('User', userSchema);
