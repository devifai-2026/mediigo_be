import mongoose from 'mongoose';
import { env } from '../config/env.js';

const doctorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    // Denormalized so doctor lists and announcements don't need a populate.
    name: { type: String, required: true, trim: true },
    specialty: { type: String, required: true, trim: true },
    qualifications: { type: [String], default: [] },
    councilRegNo: { type: String, required: true, trim: true },
    chamberNumber: { type: String, default: '' },
    experienceYears: Number,
    languages: { type: [String], default: ['English'] },

    fees: {
      fresh: { type: Number, required: true, min: 0 },
      followup: { type: Number, required: true, min: 0 },
      emergency: { type: Number, required: true, min: 0 },
    },
    followupWindowDays: { type: Number, default: 14 },

    session: {
      isBookingOpen: { type: Boolean, default: false },
      isOnBreak: { type: Boolean, default: false },
      breakReason: { type: String, default: null },
      // Server-computed. Client clocks drift, and this value drives the wait
      // estimate every waiting patient sees.
      breakUntil: { type: Date, default: null },
      lastCalledToken: { type: Number, default: 0 },
      currentTokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'OPDToken', default: null },
    },

    schedule: [
      {
        day: { type: Number, min: 0, max: 6 },
        startTime: String,
        endTime: String,
        slotMinutes: Number,
        maxTokens: Number,
      },
    ],
    avgConsultMinutes: { type: Number, default: () => env.MINUTES_PER_CONSULT },

    isActive: { type: Boolean, default: true },
    deboardedAt: Date,
  },
  { timestamps: true },
);

doctorSchema.index({ userId: 1 }, { unique: true });
doctorSchema.index({ councilRegNo: 1 }, { unique: true });
doctorSchema.index({ hospitalId: 1, isActive: 1 });
doctorSchema.index({ specialty: 1, isActive: 1 });
doctorSchema.index({ hospitalId: 1, 'session.isBookingOpen': 1 });

export const Doctor = mongoose.model('Doctor', doctorSchema);
