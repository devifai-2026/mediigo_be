import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';
import { createSchema, listSchema, lookupSchema, suggestSchema } from './schema.js';
import { createPrescription, listPrescriptions, getPrescription, lookupByPhone, sendToPharmacy, myPrescriptions } from './service.js';
import { suggestMedicines, prescribingPatterns } from './assist.js';

export const prescriptionRoutes = Router();

prescriptionRoutes.use(requireAuth, asyncHandler(requireActiveUser));

// Writing is the doctor's alone.
prescriptionRoutes.post(
  '/',
  requireRole(ROLES.DOCTOR, ROLES.SUPER_ADMIN),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ ok: true, data: await createPrescription({ body: req.body, actor: req.user }) });
  }),
);

// The front desk reads them to reprint a pad or answer "what was I given?".
prescriptionRoutes.get(
  '/',
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN),
  validate(listSchema),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await listPrescriptions({ query: req.query, actor: req.user }) });
  }),
);

// Typing aids for the pad: medicine suggestions and the doctor's usual Rx per
// diagnosis. Both read the signed-in doctor's own history. Declared before '/:id'.
prescriptionRoutes.get(
  '/medicines',
  requireRole(ROLES.DOCTOR, ROLES.SUPER_ADMIN),
  validate(suggestSchema),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await suggestMedicines({ q: req.query.q, doctorId: req.user.doctorId }) });
  }),
);

prescriptionRoutes.get(
  '/patterns',
  requireRole(ROLES.DOCTOR, ROLES.SUPER_ADMIN),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await prescribingPatterns({ doctorId: req.user.doctorId }) });
  }),
);

// A patient's own history, from the visits they booked through Mediigo.
prescriptionRoutes.get(
  '/mine',
  requireRole(ROLES.PATIENT),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await myPrescriptions({ actor: req.user }) });
  }),
);

// EMR lookup by the patient's mobile number. Declared before '/:id'.
prescriptionRoutes.get(
  '/lookup',
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN),
  validate(lookupSchema),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await lookupByPhone({ query: req.query, actor: req.user }) });
  }),
);

prescriptionRoutes.get(
  '/:id',
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await getPrescription({ id: req.params.id, actor: req.user }) });
  }),
);

// Send an already-saved prescription to the clinic pharmacy.
prescriptionRoutes.post(
  '/:id/send-to-pharmacy',
  requireRole(ROLES.DOCTOR, ROLES.SUPER_ADMIN),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await sendToPharmacy({ id: req.params.id, actor: req.user }) });
  }),
);
