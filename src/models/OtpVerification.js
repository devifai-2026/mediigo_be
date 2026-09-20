import mongoose from 'mongoose';
import { OTP_PURPOSE } from '../config/constants.js';

const otpVerificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    purpose: { type: String, enum: Object.values(OTP_PURPOSE), required: true },
    channel: { type: String, required: true }, // 'whatsapp' | 'demo' | 'console'
    address: { type: String, required: true }, // 10-digit phone
    otpHash: { type: String, required: true },
    providerMessageId: String,

    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    verifiedAt: { type: Date, default: null },

    ip: String,
    userAgent: String,
  },
  { timestamps: true },
);

// Hot path: find the live pending OTP for this address+purpose.
otpVerificationSchema.index(
  { address: 1, purpose: 1, expiresAt: 1 },
  { partialFilterExpression: { verifiedAt: null } },
);
// TTL is on createdAt (24h), deliberately NOT on expiresAt. Invalidation works by
// setting expiresAt = now(), so a TTL on that field would delete the record
// instantly and destroy the audit trail ("an OTP was issued at 14:02 and never
// verified" is exactly what support needs to see).
otpVerificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86_400 });

export const OtpVerification = mongoose.model('OtpVerification', otpVerificationSchema);
