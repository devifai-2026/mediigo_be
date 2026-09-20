import { Router } from 'express';
import { z } from 'zod';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES, NETWORK_STATE } from '../../config/constants.js';

export const adminRoutes = Router();
const ADMINS = [ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN];

const reasonSchema = { body: z.object({ reason: z.string().min(10).max(500), force: z.boolean().optional() }) };

adminRoutes.use(requireAuth, asyncHandler(requireActiveUser), requireRole(...ADMINS));

adminRoutes.get('/approvals', asyncHandler(controller.listApprovals));
adminRoutes.post('/submissions/:id/approve', asyncHandler(controller.approve));
adminRoutes.post('/submissions/:id/reject', validate(reasonSchema), asyncHandler(controller.reject));

adminRoutes.get('/hospitals', asyncHandler(controller.listHospitals));
adminRoutes.post('/hospitals/:id/suspend', validate(reasonSchema), asyncHandler(controller.suspend));
adminRoutes.post('/hospitals/:id/reactivate', asyncHandler(controller.reactivate));
// Exec Admin reaches this too, but the service downgrades them to a request.
adminRoutes.post('/hospitals/:id/deboard', validate(reasonSchema), asyncHandler(controller.deboard));
adminRoutes.get('/hospitals/:id/pending-refunds', asyncHandler(controller.pendingRefunds));
adminRoutes.post('/doctors/:id/deboard', validate(reasonSchema), asyncHandler(controller.deboardDoctor));

adminRoutes.get('/audit', asyncHandler(controller.audit));
adminRoutes.get('/dashboard', asyncHandler(controller.dashboard));
