import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { SHIFT } from '../config/constants.js';

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

    /**
     * Recurring weekly shifts. One entry per day-of-week per sitting, so a
     * doctor who sits 10-5 and again 7-8 on Mondays has two Monday rows.
     *
     * Times are 'HH:mm' in the hospital's timezone and are compared as strings,
     * which sorts correctly while zero-padded and avoids inventing a date just
     * to hold a time.
     */
    schedule: [
      {
        day: { type: Number, min: 0, max: 6, required: true }, // 0 = Sunday
        shift: { type: String, enum: Object.values(SHIFT), default: SHIFT.MORNING },
        startTime: { type: String, required: true },
        endTime: { type: String, required: true },
        // Optional. null means no cap — the sitting stays open until it ends.
        // Set it, and the shift closes to new bookings once that many are taken.
        maxTokens: { type: Number, default: null, min: 1 },
        isActive: { type: Boolean, default: true },
      },
    ],

    /**
     * Date-specific exceptions, which always win over the weekly pattern.
     *
     * `off` closes a date — the whole day when `shift` is null, otherwise just
     * that sitting. `extra` opens one that the weekly pattern does not cover.
     * Bounded by the booking horizon, so this list stays short; past entries are
     * pruned by scripts rather than kept forever.
     */
    scheduleOverrides: [
      {
        date: { type: String, required: true }, // YYYY-MM-DD
        kind: { type: String, enum: ['off', 'extra'], required: true },
        shift: { type: String, enum: Object.values(SHIFT), default: null },
        startTime: String,
        endTime: String,
        maxTokens: { type: Number, default: null, min: 1 },
        reason: { type: String, default: '' },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        createdAt: { type: Date, default: Date.now },
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
// Availability lookups scan overrides by date for one doctor.
doctorSchema.index({ 'scheduleOverrides.date': 1 });

export const Doctor = mongoose.model('Doctor', doctorSchema);
