import { Router } from 'express';
import { z } from 'zod';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES, NETWORK_STATE } from '../../config/constants.js';
import { setTrial } from '../../services/trials.js';
import { getBillingSettings } from '../../models/index.js';

export const adminRoutes = Router();
const ADMINS = [ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN];

const reasonSchema = { body: z.object({ reason: z.string().min(10).max(500), force: z.boolean().optional() }) };

// Approving may set the new doctor's or receptionist's sign-in password.
// Optional: omit it and a random one comes back as tempPassword instead. Same
// 8-72 bound as staff provisioning, so one rule governs every staff password.
const approveSchema = {
  body: z.object({
    password: z.string().min(8).max(72).optional().or(z.literal('')),
    // Bounded against the platform maximum in the service, not here: the
    // ceiling is a stored setting, and a schema cannot read the database.
    trialDays: z.coerce.number().int().min(0).max(3650).optional(),
  }).optional(),
};

adminRoutes.use(requireAuth, asyncHandler(requireActiveUser), requireRole(...ADMINS));

// Trial limits, readable by any admin who can approve. Deliberately NOT the
// full billing settings: a district admin needs the ceiling they must stay
// under, not the platform's rates.
adminRoutes.get('/trial-limits', asyncHandler(async (req, res) => {
  const s = await getBillingSettings();
  res.json({ ok: true, data: { maxTrialDays: s.maxTrialDays, defaultTrialDays: s.defaultTrialDays } });
}));

adminRoutes.get('/approvals', asyncHandler(controller.listApprovals));
adminRoutes.post('/submissions/:id/approve', validate(approveSchema), asyncHandler(controller.approve));
adminRoutes.post('/submissions/:id/reject', validate(reasonSchema), asyncHandler(controller.reject));

adminRoutes.get('/hospitals', asyncHandler(controller.listHospitals));
adminRoutes.post('/hospitals/:id/suspend', validate(reasonSchema), asyncHandler(controller.suspend));
adminRoutes.post('/hospitals/:id/reactivate', asyncHandler(controller.reactivate));
// Exec Admin reaches this too, but the service downgrades them to a request.
adminRoutes.post('/hospitals/:id/deboard', validate(reasonSchema), asyncHandler(controller.deboard));
adminRoutes.get('/hospitals/:id/pending-refunds', asyncHandler(controller.pendingRefunds));

// Grant or extend a free trial. Open to District Admin for their own district
// (assertHospitalScope enforces that) but bounded by the platform maximum,
// which only Super Admin can raise.
adminRoutes.post(
  '/hospitals/:id/trial',
  validate({ body: z.object({ days: z.coerce.number().int().min(0).max(3650) }) }),
  asyncHandler(async (req, res) => {
    const data = await setTrial({
      hospitalId: req.params.id, days: req.body.days, actor: req.user,
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    res.json({ ok: true, data });
  }),
);
adminRoutes.post('/doctors/:id/deboard', validate(reasonSchema), asyncHandler(controller.deboardDoctor));

adminRoutes.get('/audit', asyncHandler(controller.audit));
adminRoutes.get('/dashboard', asyncHandler(controller.dashboard));
