import { Router } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES, REVIEW_STATUS } from '../../config/constants.js';

export const reviewRoutes = Router();

// Public: a patient choosing a doctor sees the approved reviews before they
// sign in, same as they see the doctor at all.
reviewRoutes.get(
  '/doctor/:doctorId',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.reviewsForDoctor({ doctorId: req.params.doctorId }) });
  }),
);

reviewRoutes.use(requireAuth, asyncHandler(requireActiveUser));

reviewRoutes.get('/mine', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await service.myReviews({ actor: req.user }) });
}));

reviewRoutes.post(
  '/',
  requireRole(ROLES.PATIENT),
  validate({
    body: z.object({
      tokenId: z.string().min(1),
      rating: z.coerce.number().int().min(1).max(5),
      comment: z.string().max(1000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const data = await service.submitReview({ ...req.body, actor: req.user });
    res.status(201).json({ ok: true, data });
  }),
);

// ---- Moderation ----
const MODERATORS = [ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN];

reviewRoutes.get(
  '/moderation',
  requireRole(...MODERATORS),
  asyncHandler(async (req, res) => {
    const status = Object.values(REVIEW_STATUS).includes(req.query.status) ? req.query.status : undefined;
    res.json({ ok: true, data: await service.listForModeration({ status, actor: req.user }) });
  }),
);

reviewRoutes.post(
  '/:id/moderate',
  requireRole(...MODERATORS),
  validate({
    body: z.object({
      action: z.enum(['APPROVE', 'REJECT', 'DELETE']),
      // Present only when the moderator edited the text. The rating is
      // deliberately absent: moderation never changes someone's score.
      comment: z.string().max(1000).optional(),
      note: z.string().max(300).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const data = await service.moderateReview({
      reviewId: req.params.id, ...req.body, actor: req.user,
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    res.json({ ok: true, data });
  }),
);
