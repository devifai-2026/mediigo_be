import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { SHIFT } from '../config/constants.js';

const doctorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    // Denormalized so doctor lists and announcements don't need a populate.
    name: { type: String, required: true, trim: true },
    /**
     * The primary specialty, kept as a string. Search, seeds, the patient cards
     * and the superadmin rollups all read this, so it stays the denormalised
     * display value rather than becoming a populate on every query.
     */
    specialty: { type: String, required: true, trim: true },

    /**
     * Every specialty this doctor practises, as references to the managed list.
     * A doctor is frequently more than one thing — a physician who also does
     * paediatrics — and a single string could only ever express one of them.
     * The primary above remains whatever the card should lead with.
     */
    specialtyIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Specialty' }], default: [] },
    qualifications: { type: [String], default: [] },
    // Role at the clinic as the clinic states it — "Chief Cardiologist", "Consultant".
    designation: { type: String, default: '', trim: true },
    /**
     * Registration with the medical council. Set at onboarding and locked
     * afterwards — only a super admin may correct it (see profileFields.js).
     * The patient page shows all three as one "Registration" line.
     */
    councilRegNo: { type: String, required: true, trim: true },
    registrationCouncil: { type: String, default: '', trim: true },
    registrationYear: { type: Number, default: null },
    chamberNumber: { type: String, default: '' },
    experienceYears: Number,
    languages: { type: [String], default: ['English'] },

    /**
     * The public profile beyond the booking basics. Each list renders as its
     * own section on the patient's doctor page, and a section with nothing in
     * it is simply not drawn — so all of these are optional.
     */
    about: { type: String, default: '', trim: true },
    conditionsTreated: { type: [String], default: [] },
    proceduresPerformed: { type: [String], default: [] },
    education: { type: [String], default: [] },
    memberships: { type: [String], default: [] },
    trainings: { type: [String], default: [] },
    awards: { type: [String], default: [] },
    publications: { type: [String], default: [] },

    /**
     * Profile photo, shown on the patient-facing doctor card.
     *
     * `url` is what the browser loads; `objectPath` is the storage key behind
     * it, kept so a replacement can delete the old object instead of orphaning
     * it in the bucket. Null until someone uploads one — the card falls back to
     * initials, so a doctor without a photo is never a broken image.
     */
    photo: {
      url: { type: String, default: null },
      objectPath: { type: String, default: null },
      updatedAt: { type: Date, default: null },
    },

    /**
     * Public rating, recomputed from APPROVED reviews whenever one is
     * moderated. Denormalised so the nearby-search list does not need a
     * per-doctor aggregate on every search.
     */
    rating: {
      average: { type: Number, default: 0, min: 0, max: 5 },
      count: { type: Number, default: 0, min: 0 },
    },

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

    /**
     * The clinic's lead doctor: sees the whole clinic's revenue, footfall and
     * ledger rather than only their own. Usually the owner. Petty cash stays
     * the front desk's.
     */
    isClinicAdmin: { type: Boolean, default: false },

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
