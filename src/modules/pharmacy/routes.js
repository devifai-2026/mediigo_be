import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { PHARMACY_STATUS, ROLES } from '../../config/constants.js';
import {
  listPharmacyQueue, dispense, pharmacyStatus,
  listPharmacists, createPharmacist, setPharmacistActive, resetPharmacistPassword,
} from './service.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

export const pharmacyRoutes = Router();

pharmacyRoutes.use(requireAuth, asyncHandler(requireActiveUser));

// ---- the pharmacist's own screens ----

pharmacyRoutes.get(
  '/prescriptions',
  requireRole(ROLES.PHARMACIST),
  validate({
    query: z.object({
      view: z.enum(['PENDING', 'DONE', 'ALL']).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      q: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await listPharmacyQueue({ query: req.query, actor: req.user }) });
  }),
);

pharmacyRoutes.post(
  '/prescriptions/:id/dispense',
  requireRole(ROLES.PHARMACIST),
  validate({
    params: z.object({ id: objectId }),
    body: z.object({
      status: z.enum(Object.values(PHARMACY_STATUS)),
      unavailable: z.array(z.string().max(120)).max(30).optional().default([]),
      note: z.string().trim().max(300).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await dispense({ id: req.params.id, body: req.body, actor: req.user }) });
  }),
);

// ---- the clinic side ----

// Whether the pad should offer "Send to pharmacy".
pharmacyRoutes.get(
  '/status',
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await pharmacyStatus({ actor: req.user }) });
  }),
);

pharmacyRoutes.get(
  '/staff',
  requireRole(ROLES.DOCTOR),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await listPharmacists({ actor: req.user }) });
  }),
);

pharmacyRoutes.post(
  '/staff',
  requireRole(ROLES.DOCTOR),
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(80),
      phone: z.string().min(10).max(15),
      email: z.string().trim().email().max(120).optional().or(z.literal('')),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ ok: true, data: await createPharmacist({ body: req.body, actor: req.user, ...meta(req) }) });
  }),
);

pharmacyRoutes.patch(
  '/staff/:id',
  requireRole(ROLES.DOCTOR),
  validate({ params: z.object({ id: objectId }), body: z.object({ isActive: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await setPharmacistActive({ id: req.params.id, isActive: req.body.isActive, actor: req.user, ...meta(req) }) });
  }),
);

pharmacyRoutes.post(
  '/staff/:id/reset-password',
  requireRole(ROLES.DOCTOR),
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await resetPharmacistPassword({ id: req.params.id, actor: req.user }) });
  }),
);
