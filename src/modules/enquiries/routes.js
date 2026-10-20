import { Router } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';

export const enquiryRoutes = Router();

const text = (max) => z.string().trim().max(max).optional().default('');

const submitSchema = {
  body: z.object({
    name: z.string().trim().min(2, 'Tell us your name').max(80),
    phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
    email: z.string().trim().toLowerCase().email('Enter a valid email').max(120).optional().or(z.literal('')).default(''),
    clinicName: text(120),
    city: z.string().trim().min(2, 'Which city is your clinic in?').max(60),
    specialty: text(60),
    doctorsCount: text(10),
    preferredTime: text(40),
    message: text(1000),
    utm: z.object({ source: text(80), medium: text(80), campaign: text(120), content: text(120) }).partial().optional(),
    referrer: text(300),
    // Honeypot — hidden from people, so anything here came from a bot.
    website: z.string().max(200).optional(),
  }),
};

// ---- public: the /clinic landing page ----
enquiryRoutes.post('/', validate(submitSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ ok: true, data: await service.submitEnquiry({ body: req.body, ip: req.ip, userAgent: req.headers['user-agent'] }) });
}));

enquiryRoutes.get('/pricing', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await service.publicPricing() });
}));

// ---- super admin: every enquiry, and handing out the ones no agent covers ----
const admin = [requireAuth, asyncHandler(requireActiveUser), requireRole(ROLES.SUPER_ADMIN)];

enquiryRoutes.get('/admin', ...admin, asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await service.listEnquiries({ status: req.query.status, q: req.query.q }) });
}));

enquiryRoutes.post(
  '/admin/:id/assign',
  ...admin,
  validate({ body: z.object({ agentId: z.string().regex(/^[a-f0-9]{24}$/i, 'Pick a field agent') }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.assignEnquiry({ id: req.params.id, agentId: req.body.agentId }) });
  }),
);

enquiryRoutes.post('/admin/:id/spam', ...admin, asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await service.markSpam({ id: req.params.id }) });
}));
