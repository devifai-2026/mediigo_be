import { Router } from 'express';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, optionalAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';
import { nearbySchema, feesSchema, profileSchema, scheduleSchema, markOffSchema } from './schema.js';

export const doctorRoutes = Router();

// Public — patients browse clinics before signing in.
doctorRoutes.get('/nearby', optionalAuth, validate(nearbySchema), asyncHandler(controller.nearby));

doctorRoutes.get(
  '/',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  asyncHandler(controller.list),
);
doctorRoutes.get('/:id', optionalAuth, asyncHandler(controller.getById));

doctorRoutes.patch(
  '/:id/fees',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(feesSchema), asyncHandler(controller.updateFees),
);
doctorRoutes.patch(
  '/:id',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(profileSchema), asyncHandler(controller.updateProfile),
);

// ---- Scheduling ----
// Public: a patient picking a date needs this before they sign in.
doctorRoutes.get('/:id/availability', optionalAuth, asyncHandler(controller.availability));

doctorRoutes.put(
  '/:id/schedule',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(scheduleSchema), asyncHandler(controller.updateSchedule),
);

// The clinic's front desk marks a doctor off as often as the doctor does.
doctorRoutes.post(
  '/:id/off',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(markOffSchema), asyncHandler(controller.markOff),
);
doctorRoutes.post(
  '/:id/off/clear',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(markOffSchema), asyncHandler(controller.clearOff),
);
