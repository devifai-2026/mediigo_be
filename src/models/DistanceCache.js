import mongoose from 'mongoose';

// Google Distance Matrix bills per origin×destination element. Caching on a
// coordinate rounded to ~110m is what makes repeat searches from the same
// neighbourhood free.
const distanceCacheSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    distanceMeters: Number,
    durationSeconds: Number,
    source: { type: String, enum: ['GOOGLE', 'HAVERSINE'], default: 'GOOGLE' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

distanceCacheSchema.index({ key: 1 }, { unique: true });
distanceCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DistanceCache = mongoose.model('DistanceCache', distanceCacheSchema);
