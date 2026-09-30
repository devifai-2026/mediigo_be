import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import * as service from './service.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';

export const specialtyRoutes = Router();

// Memory storage: the upload is re-encoded by sharp immediately, so writing the
// caller's bytes to disk first would only leave attacker-controlled content
// lying around.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

const ADMINS = [ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN];

const bodySchema = {
  body: z.object({
    name: z.string().trim().min(2).max(60),
    tileLabel: z.string().max(60).optional(),
    description: z.string().max(300).optional(),
    order: z.coerce.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
  }),
};

const patchSchema = {
  body: z.object({
    name: z.string().trim().min(2).max(60).optional(),
    tileLabel: z.string().max(60).optional(),
    description: z.string().max(300).optional(),
    order: z.coerce.number().int().min(0).max(10000).optional(),
    isActive: z.boolean().optional(),
  }),
};

// ---- Public ----
// The patient browse grid reads this before anyone signs in. `all=1` is the
// admin view and is gated below, not here, so the public list can never leak a
// specialty an admin has deliberately hidden.
specialtyRoutes.get('/', asyncHandler(async (_req, res) => {
  res.json({ ok: true, data: await service.listSpecialties({ includeHidden: false }) });
}));

// ---- Admin ----
specialtyRoutes.get(
  '/all',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...ADMINS),
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await service.listSpecialties({ includeHidden: true }) });
  }),
);

specialtyRoutes.post(
  '/',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...ADMINS),
  validate(bodySchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ ok: true, data: await service.createSpecialty({ body: req.body, actor: req.user }) });
  }),
);

// Declared BEFORE /:id so "reorder" is never captured as an id.
specialtyRoutes.put(
  '/reorder',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...ADMINS),
  validate({ body: z.object({ ids: z.array(z.string()).min(1).max(200) }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.reorderSpecialties({ ids: req.body.ids }) });
  }),
);

specialtyRoutes.patch(
  '/:id',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...ADMINS),
  validate(patchSchema),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.updateSpecialty({ id: req.params.id, patch: req.body }) });
  }),
);

specialtyRoutes.delete(
  '/:id',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...ADMINS),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.deleteSpecialty({ id: req.params.id }) });
  }),
);

specialtyRoutes.put(
  '/:id/photo',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...ADMINS),
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.setSpecialtyPhoto({ id: req.params.id, file: req.file }) });
  }),
);

specialtyRoutes.delete(
  '/:id/photo',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...ADMINS),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.removeSpecialtyPhoto({ id: req.params.id }) });
  }),
);
