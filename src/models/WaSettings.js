import mongoose from 'mongoose';
import { ROLES } from '../config/constants.js';
import { env } from '../config/env.js';

// Runtime configuration, editable by Super Admin. Middle tier of the three-tier
// credential resolution: hospital override -> this document -> env fallback.
// Demo mode lives here (not only in env) so it can be flipped from the UI.
const waSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'singleton' },
    enabled: { type: Boolean, default: false },
    provider: { type: String, enum: ['console', 'wabridge'], default: 'console' },

    wabridgeBaseUrl: { type: String, default: () => env.WABRIDGE_BASE_URL },
    wabridgeAppKey: { type: String, default: '' },
    wabridgeAuthKey: { type: String, default: '', select: false },
    wabridgeDeviceId: { type: String, default: '' },

    templateOtp: { type: String, default: '' },
    templateTokenBooked: { type: String, default: '' },
    templateTokenNearing: { type: String, default: '' },
    templateDoctorBreak: { type: String, default: '' },
    templateHospitalApproved: { type: String, default: '' },

    otpDemo: { type: Boolean, default: true },
    otpDemoCode: { type: String, default: '1234' },
    otpTtlMinutes: { type: Number, default: 5 },
    otpMaxAttempts: { type: Number, default: 5 },
    otpLength: { type: Number, default: 6 },

    // Which roles must pass a WhatsApp OTP second factor after their password.
    // Authored in one place so LoginView never has to know the policy.
    require2faRoles: {
      type: [String],
      enum: Object.values(ROLES),
      default: [],
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, _id: false },
);

export const WaSettings = mongoose.model('WaSettings', waSettingsSchema);
