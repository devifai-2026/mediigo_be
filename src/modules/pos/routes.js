import { Router } from 'express';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';
import { walkinSchema, paySchema, dayCloseSchema } from './schema.js';

export const posRoutes = Router();

posRoutes.use(requireAuth, asyncHandler(requireActiveUser));

posRoutes.post(
  '/walkin',
  requireRole(ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN),
  validate(walkinSchema),
  asyncHandler(controller.walkin),
);
// A doctor may collect too — some clinics take the money in the chamber rather
// than at the desk. Who actually took it is recorded on the transaction, and
// day-close reconciles per collector, so both routes stay auditable.
posRoutes.post(
  '/tokens/:tokenId/pay',
  requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.SUPER_ADMIN),
  validate(paySchema),
  asyncHandler(controller.pay),
);
posRoutes.get(
  '/day-close',
  requireRole(ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(dayCloseSchema),
  asyncHandler(controller.dayClose),
);
