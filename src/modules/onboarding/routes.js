import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { assertUploadable, processPhoto, processAvatar, putObject } from '../../services/storage.js';
import * as service from './service.js';
import { suggestAddresses, resolvePlace, placesEnabled } from './lookup.js';
import * as leads from './leads.js';
import { VISIT_OUTCOME } from '../../models/index.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';

export const onboardingRoutes = Router();

const createSchema = {
  body: z.object({
    kind: z.enum(['HOSPITAL', 'DOCTOR']),
    districtId: z.string().optional(),
    payload: z.record(z.any()),
    documents: z.array(z.object({ kind: z.string(), url: z.string() })).optional(),
    leadId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  }),
};

const phone = z.string().trim().regex(/^\d{10}$/, 'Enter a 10-digit mobile number').optional().or(z.literal(''));
const when = z.coerce.date().optional().nullable();
const leadFields = {
  clinicName: z.string().trim().min(2, 'Clinic name is required').max(120),
  contactName: z.string().trim().max(80).optional(),
  contactPhone: phone,
  specialty: z.string().trim().max(60).optional(),
  address: z.object({
    line1: z.string().trim().max(200).optional(),
    city: z.string().trim().max(60).optional(),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode is 6 digits').optional().or(z.literal('')),
  }).optional(),
  notes: z.string().trim().max(1000).optional(),
  nextVisitAt: when,
};
const visitBody = z.object({
  outcome: z.enum(Object.values(VISIT_OUTCOME).filter((o) => o !== 'ONBOARDED')),
  note: z.string().trim().max(1000).optional(),
  nextVisitAt: when,
});
const createLeadSchema = { body: z.object({ ...leadFields, visit: visitBody.optional() }) };
const updateLeadSchema = { body: z.object(leadFields).partial() };
const visitSchema = { body: visitBody };
const perfSchema = {
  query: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    agentId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  }),
};

onboardingRoutes.use(requireAuth, asyncHandler(requireActiveUser));

// Address autocomplete, proxied so the Places key stays server-side.
onboardingRoutes.get(
  '/address/suggest',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: { enabled: placesEnabled(), suggestions: await suggestAddresses(req.query.q) } });
  }),
);

onboardingRoutes.get(
  '/address/resolve',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await resolvePlace(req.query.placeId) });
  }),
);

// Photos taken during onboarding. The clinic does not exist yet, so they are
// stored under the uploader and referenced from the submission's payload;
// approval copies them onto the clinic. Memory storage for the same reason as
// doctor photos: sharp re-encodes immediately, nothing raw touches disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
onboardingRoutes.post(
  '/uploads',
  requireRole(ROLES.FIELD_AGENT, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    assertUploadable(req.file);
    // ?kind=avatar for a doctor's portrait (square crop, like the profile
    // upload); anything else is a premises photo kept in its own shape.
    const processed = req.query.kind === 'avatar' ? await processAvatar(req.file.buffer) : await processPhoto(req.file.buffer);
    const stored = await putObject({ ...processed, prefix: `onboarding/${req.user.id}` });
    res.status(201).json({ ok: true, data: stored });
  }),
);

onboardingRoutes.post(
  '/submissions',
  requireRole(ROLES.FIELD_AGENT, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(createSchema),
  asyncHandler(async (req, res) => res.status(201).json({ ok: true, data: await service.create({ body: req.body, actor: req.user }) })),
);
onboardingRoutes.patch(
  '/submissions/:id',
  requireRole(ROLES.FIELD_AGENT, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  asyncHandler(async (req, res) => res.json({ ok: true, data: await service.update({ id: req.params.id, body: req.body, actor: req.user }) })),
);
onboardingRoutes.post(
  '/submissions/:id/submit',
  requireRole(ROLES.FIELD_AGENT, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  asyncHandler(async (req, res) => res.json({ ok: true, data: await service.submit({ id: req.params.id, actor: req.user }) })),
);
onboardingRoutes.get(
  '/submissions',
  asyncHandler(async (req, res) => res.json({ ok: true, data: await service.list({ actor: req.user, status: req.query.status }) })),
);
onboardingRoutes.get(
  '/submissions/:id',
  asyncHandler(async (req, res) => res.json({ ok: true, data: await service.getById({ id: req.params.id, actor: req.user }) })),
);

// ---- Field agent follow-ups and performance ----

onboardingRoutes.get(
  '/leads',
  requireRole(ROLES.FIELD_AGENT, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  asyncHandler(async (req, res) => res.json({ ok: true, data: await leads.listLeads({ actor: req.user, query: req.query }) })),
);
onboardingRoutes.post(
  '/leads',
  requireRole(ROLES.FIELD_AGENT),
  validate(createLeadSchema),
  asyncHandler(async (req, res) => res.status(201).json({ ok: true, data: await leads.createLead({ body: req.body, actor: req.user }) })),
);
onboardingRoutes.patch(
  '/leads/:id',
  requireRole(ROLES.FIELD_AGENT, ROLES.SUPER_ADMIN),
  validate(updateLeadSchema),
  asyncHandler(async (req, res) => res.json({ ok: true, data: await leads.updateLead({ id: req.params.id, body: req.body, actor: req.user }) })),
);
onboardingRoutes.post(
  '/leads/:id/visits',
  requireRole(ROLES.FIELD_AGENT, ROLES.SUPER_ADMIN),
  validate(visitSchema),
  asyncHandler(async (req, res) => res.json({ ok: true, data: await leads.logVisit({ id: req.params.id, body: req.body, actor: req.user }) })),
);
onboardingRoutes.get(
  '/performance',
  requireRole(ROLES.FIELD_AGENT, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(perfSchema),
  asyncHandler(async (req, res) => res.json({ ok: true, data: await leads.agentPerformance({ actor: req.user, query: req.query }) })),
);
