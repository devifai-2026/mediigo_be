import mongoose from 'mongoose';
import { toPoint } from '../lib/geo.js';

const districtSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    state: { type: String, required: true, trim: true },
    // Drives the policy gap engine's room-rent and sum-insured benchmarks. A
    // Tier-1 metro room costs ~3x a Tier-3 one, so a single national benchmark
    // would make the analysis wrong almost everywhere.
    cityTier: { type: Number, enum: [1, 2, 3], default: 2 },
    centroid: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: () => [0, 0] },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

districtSchema.index({ code: 1 }, { unique: true });
districtSchema.index({ state: 1, name: 1 });
districtSchema.index({ centroid: '2dsphere' });

districtSchema.statics.buildCentroid = (lng, lat) => toPoint(lng, lat);

export const District = mongoose.model('District', districtSchema);
