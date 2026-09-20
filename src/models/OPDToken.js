import mongoose from 'mongoose';
import { TOKEN_STATUS, VISIT_TYPE, TOKEN_SOURCE, SHIFT } from '../config/constants.js';

const opdTokenSchema = new mongoose.Schema(
  {
    tokenNumber: { type: Number, required: true },
    // 'YYYY-MM-DD' in the hospital's timezone, ALWAYS server-derived via
    // clinicDate(). A string keeps the compound index a pure equality prefix and
    // sidesteps UTC-midnight drift entirely.
    date: { type: String, required: true },

    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    familyMemberId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Frozen at booking time: the patient may edit their profile later, but the
    // token must still show who actually attended.
    patientSnapshot: {
      name: String,
      phone: String,
      age: Number,
      gender: String,
      complaint: String,
    },

    // Which sitting this token belongs to. Token numbers restart per shift, so
    // a doctor's evening list is not numbered on from the morning's.
    shift: { type: String, enum: Object.values(SHIFT), default: SHIFT.MORNING },
    startTime: { type: String, default: '' },
    endTime: { type: String, default: '' },

    visitType: { type: String, enum: Object.values(VISIT_TYPE), default: VISIT_TYPE.FRESH },
    source: { type: String, enum: Object.values(TOKEN_SOURCE), default: TOKEN_SOURCE.APP },
    standeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'QRStandee', default: null },

    status: { type: String, enum: Object.values(TOKEN_STATUS), default: TOKEN_STATUS.WAITING },
    // Append-only. This is what settles "I was skipped unfairly" disputes.
    statusHistory: [
      {
        from: String,
        to: String,
        at: { type: Date, default: Date.now },
        byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reason: String,
      },
    ],

    calledAt: Date,
    enteredChamberAt: Date,
    completedAt: Date,
    skippedAt: Date,
    skipReason: String,
    recallCount: { type: Number, default: 0 },

    // Set when a doctor goes off after this was booked. The token keeps its
    // place in RESCHEDULE_NEEDED until the patient picks a new slot, so nobody
    // is silently moved and nobody silently loses their booking.
    rescheduleReason: { type: String, default: null },
    rescheduledFrom: {
      date: String,
      shift: String,
      tokenNumber: Number,
    },

    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    isPaid: { type: Boolean, default: false },
    bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// The spec's compound unique index. Used here as an optimistic-concurrency
// primitive, not merely a constraint: it is the backstop that guarantees no two
// patients can ever hold the same token number for a doctor on a given day.
opdTokenSchema.index({ doctorId: 1, date: 1, shift: 1, tokenNumber: 1 }, { unique: true });
opdTokenSchema.index({ doctorId: 1, date: 1, status: 1 });
opdTokenSchema.index({ patientId: 1, createdAt: -1 });
opdTokenSchema.index({ hospitalId: 1, date: 1 });
opdTokenSchema.index({ date: 1 });

export const OPDToken = mongoose.model('OPDToken', opdTokenSchema);
