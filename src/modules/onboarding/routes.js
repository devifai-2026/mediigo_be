import { Router } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { suggestAddresses, resolvePlace, placesEnabled } from './lookup.js';
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
