import { Router } from 'express';
import { z } from 'zod';
import * as service from './service.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';
import { TICKET_STATUS, TICKET_PRIORITY, TICKET_CATEGORY } from '../../models/Ticket.js';

export const ticketRoutes = Router();

// Any signed-in role may raise and track a ticket — that is the point.
ticketRoutes.use(requireAuth, asyncHandler(requireActiveUser));

const meta = (req) => ({ actor: req.user, ip: req.ip, userAgent: req.headers['user-agent'] });

ticketRoutes.post(
  '/',
  validate({
    body: z.object({
      title: z.string().trim().min(4).max(140),
      body: z.string().trim().min(10).max(4000),
      category: z.enum(Object.values(TICKET_CATEGORY)).default(TICKET_CATEGORY.OTHER),
      priority: z.enum(Object.values(TICKET_PRIORITY)).default(TICKET_PRIORITY.MEDIUM),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ ok: true, data: await service.createTicket({ body: req.body, ...meta(req) }) });
  }),
);

ticketRoutes.get('/', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await service.listTickets({ actor: req.user, ...req.query }) });
}));

ticketRoutes.get('/summary', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await service.ticketSummary(req.user) });
}));

// System log sits here because it shares the ticket page and the same scoping.
ticketRoutes.get(
  '/system-log',
  requireRole(ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.systemLog({ actor: req.user, action: req.query.action, limit: Number(req.query.limit) || 200 }) });
  }),
);

ticketRoutes.get('/:id', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await service.getTicket({ ticketId: req.params.id, actor: req.user }) });
}));

ticketRoutes.post(
  '/:id/move',
  validate({ body: z.object({ to: z.enum(Object.values(TICKET_STATUS)), note: z.string().max(1000).optional() }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.moveTicket({ ticketId: req.params.id, to: req.body.to, note: req.body.note, ...meta(req) }) });
  }),
);

ticketRoutes.post(
  '/:id/comments',
  validate({ body: z.object({ body: z.string().trim().min(1).max(2000), internal: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.commentOnTicket({ ticketId: req.params.id, body: req.body.body, internal: req.body.internal, actor: req.user }) });
  }),
);

ticketRoutes.post(
  '/:id/assign',
  validate({ body: z.object({ assigneeId: z.string().optional().or(z.literal('')).nullable() }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.assignTicket({ ticketId: req.params.id, assigneeId: req.body.assigneeId || null, actor: req.user }) });
  }),
);
