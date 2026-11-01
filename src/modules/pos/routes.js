import { Router } from 'express';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole, assertHospitalScope } from '../../middleware/rbac.js';
import { Hospital } from '../../models/index.js';
import { ROLES } from '../../config/constants.js';
import {
  walkinSchema, paySchema, dayCloseSchema, expenseSchema, voidExpenseSchema, deskQuerySchema,
} from './schema.js';
import { revenueAnalytics } from './analytics.js';
import { walkinSittings } from './service.js';
import { z } from 'zod';
import { logExpense, voidExpense, ledger, footfall, reportDoctorId, assertDeskWindow } from './desk.js';
import { validationError } from '../../lib/errors.js';

export const posRoutes = Router();

posRoutes.use(requireAuth, asyncHandler(requireActiveUser));

// Reports the front desk may open only for recent days; see assertDeskWindow.
const deskWindow = asyncHandler(async (req, _res, next) => {
  await assertDeskWindow(req.user, req.query);
  next();
});

// Doctors too: in a single-doctor clinic the doctor is often the desk. The
// clinic scope check in the service still confines them to their own clinic.
// Today's sittings for the walk-in form, with the token each would get now.
posRoutes.get(
  '/walkin/sittings',
  requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.SUPER_ADMIN),
  validate({ query: z.object({ doctorId: z.string().regex(/^[a-f0-9]{24}$/i) }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await walkinSittings({ doctorId: req.query.doctorId, actor: req.user }) });
  }),
);
posRoutes.post(
  '/walkin',
  requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.SUPER_ADMIN),
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
// Revenue and patient analytics over a window. Scoped to the caller's own
// clinic for desk staff; an admin may name one. A doctor only ever sees their
// own figures, whatever doctorId they pass.
posRoutes.get(
  '/analytics',
  requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(deskQuerySchema),
  deskWindow,
  asyncHandler(async (req, res) => {
    const hospitalId = req.user.hospitalId || req.query.hospitalId;
    if (!hospitalId) throw validationError([{ path: 'query.hospitalId', message: 'No clinic in scope — pass hospitalId' }]);
    // An admin-named clinic must be one they may see: a district admin reading
    // another district's revenue was possible before this.
    assertHospitalScope(req.user, await Hospital.findById(hospitalId).select('districtId').lean());
    const doctorId = await reportDoctorId(req.user, req.query.doctorId);
    res.json({
      ok: true,
      data: await revenueAnalytics({
        hospitalId, period: req.query.period, doctorId,
        date: req.query.date, from: req.query.from, to: req.query.to,
      }),
    });
  }),
);

posRoutes.get(
  '/day-close',
  requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(dayCloseSchema),
  deskWindow,
  asyncHandler(controller.dayClose),
);

// ---- Ledger, footfall register and petty cash ----

const DESK_READ = [ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN];

posRoutes.get(
  '/ledger',
  requireRole(...DESK_READ),
  validate(deskQuerySchema),
  deskWindow,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await ledger({ actor: req.user, query: req.query }) });
  }),
);

posRoutes.get(
  '/footfall',
  requireRole(...DESK_READ),
  validate(deskQuerySchema),
  deskWindow,
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await footfall({ actor: req.user, query: req.query }) });
  }),
);

// Petty cash comes out of the desk drawer, so only the people who run the
// drawer record it. A doctor's ledger is their own takings and has no drawer.
posRoutes.post(
  '/expenses',
  requireRole(ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN),
  validate(expenseSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ ok: true, data: await logExpense({ body: req.body, actor: req.user }) });
  }),
);

posRoutes.post(
  '/expenses/:id/void',
  requireRole(ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN),
  validate(voidExpenseSchema),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await voidExpense({ id: req.params.id, reason: req.body.reason, actor: req.user }) });
  }),
);
