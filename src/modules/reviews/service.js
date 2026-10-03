import mongoose from 'mongoose';
import { Review, OPDToken, Doctor } from '../../models/index.js';
import { REVIEW_STATUS, TOKEN_STATUS, ROLES, AUDIT_ACTIONS } from '../../config/constants.js';
import { conflict, notFound, forbidden } from '../../lib/errors.js';
import { writeAuditLog } from '../../lib/auditLog.js';

/**
 * Patient ratings of a consultation.
 *
 * Every review is held for moderation before anyone sees it, so a doctor's
 * public score only ever reflects reviews a human has looked at. The cost is
 * a queue; the benefit is that a single furious review cannot define a
 * practice before anyone notices it.
 */

/** Only a completed consultation can be rated, and only by the patient who had it. */
const loadRateableToken = async ({ tokenId, actor }) => {
  const token = await OPDToken.findById(tokenId).lean();
  if (!token) throw notFound('Consultation not found');
  if (String(token.patientId) !== String(actor.id)) {
    throw forbidden('You can only rate your own consultations');
  }
  if (token.status !== TOKEN_STATUS.COMPLETED) {
    throw conflict('You can rate a consultation once it is complete');
  }
  return token;
};

export const submitReview = async ({ tokenId, rating, comment, actor }) => {
  const token = await loadRateableToken({ tokenId, actor });

  // Re-submitting replaces the previous one and sends it back for moderation:
  // an edited review that kept its approval would be an unreviewed review
  // wearing an approved badge.
  const review = await Review.findOneAndUpdate(
    { tokenId: token._id },
    {
      $set: {
        doctorId: token.doctorId,
        hospitalId: token.hospitalId,
        patientId: token.patientId,
        rating,
        comment: String(comment || '').trim(),
        originalComment: String(comment || '').trim(),
        status: REVIEW_STATUS.PENDING,
        moderatedBy: null,
        moderatedAt: null,
        patientName: token.patientSnapshot?.name || '',
        visitDate: token.date,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await refreshDoctorRating(token.doctorId);
  return review.toObject();
};

/** What this patient has already said, so the app can show and edit it. */
export const myReviews = async ({ actor }) => {
  const rows = await Review.find({ patientId: actor.id }).sort({ createdAt: -1 }).limit(100).lean();
  return rows.map((r) => ({
    id: String(r._id),
    tokenId: String(r.tokenId),
    doctorId: String(r.doctorId),
    rating: r.rating,
    comment: r.comment,
    status: r.status,
    visitDate: r.visitDate,
    createdAt: r.createdAt,
  }));
};

/** Public list for a doctor — approved only, by definition. */
export const reviewsForDoctor = async ({ doctorId }) => {
  const rows = await Review.find({ doctorId, status: REVIEW_STATUS.APPROVED })
    .sort({ createdAt: -1 }).limit(100).lean();
  return rows.map((r) => ({
    id: String(r._id),
    rating: r.rating,
    comment: r.comment,
    // First name only: a review is about the doctor, not a directory of who
    // visited them.
    patientName: (r.patientName || 'Patient').split(' ')[0],
    visitDate: r.visitDate,
    createdAt: r.createdAt,
  }));
};

/**
 * Recompute a doctor's public rating from APPROVED reviews only.
 *
 * Stored on the doctor so the nearby-search list does not need a per-doctor
 * aggregate, and recomputed on every moderation rather than incremented —
 * an average maintained by arithmetic drifts the first time a row is edited
 * or deleted.
 */
export const refreshDoctorRating = async (doctorId) => {
  const [agg] = await Review.aggregate([
    { $match: { doctorId: new mongoose.Types.ObjectId(String(doctorId)), status: REVIEW_STATUS.APPROVED } },
    { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } },
  ]);
  await Doctor.updateOne(
    { _id: doctorId },
    { $set: { 'rating.average': agg?.avg ? Math.round(agg.avg * 10) / 10 : 0, 'rating.count': agg?.n || 0 } },
  );
  return { average: agg?.avg ?? 0, count: agg?.n ?? 0 };
};

// ---- Moderation ----

export const listForModeration = async ({ status, actor }) => {
  const q = {};
  if (status) q.status = status;
  // An exec admin sees only their own district's clinics.
  if (actor.role === ROLES.EXEC_ADMIN) {
    const docs = await Doctor.find({}, { _id: 1, hospitalId: 1 }).lean();
    q.doctorId = { $in: docs.map((d) => d._id) };
  }
  const rows = await Review.find(q).sort({ status: 1, createdAt: -1 }).limit(300).lean();
  const doctors = await Doctor.find({ _id: { $in: rows.map((r) => r.doctorId) } }, { name: 1 }).lean();
  const nameBy = new Map(doctors.map((d) => [String(d._id), d.name]));
  return rows.map((r) => ({
    id: String(r._id),
    doctorId: String(r.doctorId),
    doctorName: nameBy.get(String(r.doctorId)) || 'Unknown',
    patientName: r.patientName,
    rating: r.rating,
    comment: r.comment,
    originalComment: r.originalComment,
    edited: Boolean(r.originalComment && r.originalComment !== r.comment),
    status: r.status,
    visitDate: r.visitDate,
    createdAt: r.createdAt,
  }));
};

/**
 * Approve, reject, or edit a review.
 *
 * The comment may be edited — to strip a phone number, an insult, or a named
 * third party. The RATING may not: changing someone's stars would make the
 * published average a number no patient actually gave.
 */
export const moderateReview = async ({ reviewId, action, comment, note, actor, ip, userAgent }) => {
  const review = await Review.findById(reviewId);
  if (!review) throw notFound('Review not found');

  if (action === 'DELETE') {
    await Review.deleteOne({ _id: review._id });
    await refreshDoctorRating(review.doctorId);
    writeAuditLog({
      actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.REVIEW_MODERATED,
      entityType: 'Review', entityId: review._id, reason: note || 'Review deleted', ip, userAgent,
    });
    return { deleted: true };
  }

  const $set = { moderatedBy: actor.id, moderatedAt: new Date(), moderationNote: note || '' };
  if (comment !== undefined) $set.comment = String(comment).trim();
  if (action === 'APPROVE') $set.status = REVIEW_STATUS.APPROVED;
  if (action === 'REJECT') $set.status = REVIEW_STATUS.REJECTED;

  await Review.updateOne({ _id: review._id }, { $set });
  await refreshDoctorRating(review.doctorId);
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.REVIEW_MODERATED,
    entityType: 'Review', entityId: review._id,
    reason: `${action}${comment !== undefined ? ' (comment edited)' : ''}`, ip, userAgent,
  });
  return Review.findById(review._id).lean();
};
