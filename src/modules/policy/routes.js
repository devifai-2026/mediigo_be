import { Router } from 'express';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';
import { lookupSchema, addPolicySchema, hashParam } from './schema.js';

export const policyRoutes = Router();

policyRoutes.use(requireAuth, asyncHandler(requireActiveUser));

policyRoutes.post(
  '/vault/lookup',
  requireRole(ROLES.PATIENT, ROLES.FIELD_AGENT, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(lookupSchema), asyncHandler(controller.lookup),
);
policyRoutes.get('/vault/:aadhaarHash/policies', validate(hashParam), asyncHandler(controller.list));
policyRoutes.get('/vault/:aadhaarHash/gap-analysis', validate(hashParam), asyncHandler(controller.gapAnalysis));

policyRoutes.post(
  '/policies',
  requireRole(ROLES.PATIENT, ROLES.FIELD_AGENT, ROLES.SUPER_ADMIN),
  validate(addPolicySchema), asyncHandler(controller.add),
);
policyRoutes.patch(
  '/policies/:id',
  requireRole(ROLES.PATIENT, ROLES.FIELD_AGENT, ROLES.SUPER_ADMIN),
  asyncHandler(controller.update),
);
