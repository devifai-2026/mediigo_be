import mongoose from 'mongoose';
import { REVIEW_STATUS } from '../config/constants.js';

/**
 * A patient's rating of one consultation.
 *
 * Anchored to a token, not merely to a doctor: a review must be earned by an
 * actual completed visit, which is what stops a doctor's rating being set by
 * people who never saw them. One review per token, enforced by the database.
 *
 * Every review is held for moderation before it appears. That is a deliberate
 * trade — it protects doctors from a bad night going public unexamined, at the
 * cost of a queue someone has to work. The admin may edit the text (to strip
 * a phone number or an insult) but NEVER the stars: editing someone's score
 * would make the aggregate a fiction.
 */
const reviewSchema = new mongoose.Schema(
  {
    tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'OPDToken', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '', maxlength: 1000 },
    // What the patient actually wrote, kept when an admin edits the comment so
    // moderation is auditable rather than a silent rewrite.
    originalComment: { type: String, default: '' },

    status: { type: String, enum: Object.values(REVIEW_STATUS), default: REVIEW_STATUS.PENDING },
    moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    moderatedAt: { type: Date, default: null },
    moderationNote: { type: String, default: '' },

    // Denormalised for the admin queue and the public list, so neither needs a
    // join to show who left it and when they were seen.
    patientName: { type: String, default: '' },
    visitDate: { type: String, default: '' },
  },
  { timestamps: true },
);

// One review per consultation. A patient revising theirs updates this row.
reviewSchema.index({ tokenId: 1 }, { unique: true });
reviewSchema.index({ doctorId: 1, status: 1 });
reviewSchema.index({ status: 1, createdAt: -1 });
reviewSchema.index({ patientId: 1, createdAt: -1 });

export const Review = mongoose.model('Review', reviewSchema);
