import { Router } from 'express';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, optionalAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';
import { queryDate, statusSchema, breakSchema, bookSchema, bookingOpenSchema, rescheduleSchema } from './schema.js';

export const queueRoutes = Router();

const DESK = [ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN];

// Public: a waiting-room display or a patient checking progress. Names are
// masked for anyone who is not staff.
queueRoutes.get('/:doctorId', optionalAuth, validate(queryDate), asyncHandler(controller.getQueue));

queueRoutes.post(
  '/:doctorId/call-next',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  asyncHandler(controller.callNext),
);
queueRoutes.post(
  '/:doctorId/recall',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  asyncHandler(controller.recall),
);
queueRoutes.post(
  '/:doctorId/break',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  validate(breakSchema), asyncHandler(controller.startBreak),
);
queueRoutes.post(
  '/:doctorId/resume',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  asyncHandler(controller.endBreak),
);
queueRoutes.post(
  '/:doctorId/booking',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  validate(bookingOpenSchema), asyncHandler(controller.setBookingOpen),
);

queueRoutes.post(
  '/tokens/:tokenId/status',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  validate(statusSchema), asyncHandler(controller.setStatus),
);
queueRoutes.post(
  '/tokens/:tokenId/restore',
  requireAuth, asyncHandler(requireActiveUser), requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.SUPER_ADMIN),
  asyncHandler(controller.restore),
);

queueRoutes.post(
  '/book',
  requireAuth, asyncHandler(requireActiveUser), requireRole(ROLES.PATIENT),
  validate(bookSchema), asyncHandler(controller.book),
);
queueRoutes.delete(
  '/tokens/:tokenId',
  requireAuth, asyncHandler(requireActiveUser),
  asyncHandler(controller.cancel),
);

// ---- Reschedule: a doctor went off and this patient must move ----
queueRoutes.get(
  '/tokens/:tokenId/reschedule-options',
  requireAuth, asyncHandler(requireActiveUser),
  asyncHandler(controller.rescheduleChoices),
);
queueRoutes.post(
  '/tokens/:tokenId/reschedule',
  requireAuth, asyncHandler(requireActiveUser),
  validate(rescheduleSchema), asyncHandler(controller.reschedule),
);
