import mongoose from 'mongoose';

// Sequence allocator for token numbers and receipt numbers. See lib/counters.js
// for why this exists alongside the compound unique index.
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
    // Token counters are per-day and self-clean; receipt counters have no expiry.
    expiresAt: { type: Date, default: null },
  },
  { versionKey: false },
);

counterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Counter = mongoose.model('Counter', counterSchema);
