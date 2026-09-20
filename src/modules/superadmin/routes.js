import { Router } from 'express';
import { z } from 'zod';
import { WaSettings, District, User, Hospital, Doctor, OPDToken, Transaction } from '../../models/index.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { getWaSettings, bustWaSettingsCache, getDriver } from '../../lib/providers/index.js';
import { hashPassword } from '../auth/service.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { notFound, validationError } from '../../lib/errors.js';
import { ROLES, NETWORK_STATE, TOKEN_STATUS, AUDIT_ACTIONS } from '../../config/constants.js';
import { clinicDate } from '../../lib/dates.js';
import { getConsole } from './console.js';
import * as staff from './staff.js';

export const superadminRoutes = Router();
superadminRoutes.use(requireAuth, asyncHandler(requireActiveUser), requireRole(ROLES.SUPER_ADMIN));

// ---- Unified console payload ----
// The Super Admin console renders 8 sections and 5 charts off one state object;
// serving it in a single request avoids 8 round-trips on every tab switch.
superadminRoutes.get('/console', asyncHandler(async (_req, res) => {
  res.json({ ok: true, data: await getConsole() });
}));

// ---- Districts ----
superadminRoutes.get('/districts', asyncHandler(async (_req, res) => {
  res.json({ ok: true, data: await District.find().sort({ state: 1, name: 1 }).lean() });
}));

superadminRoutes.post(
  '/districts',
  validate({
    body: z.object({
      name: z.string().min(2), code: z.string().min(2).max(12), state: z.string().min(2),
      cityTier: z.coerce.number().int().min(1).max(3).default(2),
      lng: z.coerce.number().optional(), lat: z.coerce.number().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { lng, lat, ...rest } = req.body;
    const doc = { ...rest };
    if (lng != null && lat != null) doc.centroid = { type: 'Point', coordinates: [lng, lat] };
    res.status(201).json({ ok: true, data: await District.create(doc) });
  }),
);

// ---- Staff provisioning ----
superadminRoutes.post(
  '/users',
  validate({
    body: z.object({
      phone: z.string().min(10).max(12),
      name: z.string().min(2).max(80),
      role: z.enum([ROLES.EXEC_ADMIN, ROLES.FIELD_AGENT, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN]),
      email: z.string().email().optional(),
      password: z.string().min(8).max(72),
      districtId: z.string().optional(),
      hospitalId: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { password, ...rest } = req.body;
    const user = await User.create({ ...rest, passwordHash: await hashPassword(password), createdBy: req.user.id });
    writeAuditLog({
      actorId: req.user.id, actorRole: req.user.role, action: AUDIT_ACTIONS.USER_CREATED,
      entityType: 'User', entityId: user._id, after: { role: user.role, phone: user.phone },
    });
    res.status(201).json({ ok: true, data: user.toSafeJSON() });
  }),
);

// ---- Staff administration ----
const meta = (req) => ({ actor: req.user, ip: req.ip, userAgent: req.headers['user-agent'] });

superadminRoutes.get('/staff', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await staff.listStaff({ role: req.query.role }) });
}));

superadminRoutes.get('/staff/:id', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await staff.staffProfile(req.params.id) });
}));

superadminRoutes.post(
  '/staff',
  validate({
    body: z.object({
      name: z.string().min(2).max(80),
      phone: z.string().min(10).max(13),
      role: z.enum([ROLES.EXEC_ADMIN, ROLES.FIELD_AGENT, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN]),
      email: z.string().email().optional().or(z.literal('')),
      password: z.string().min(8).max(72).optional().or(z.literal('')),
      districtId: z.string().optional().or(z.literal('')),
      hospitalId: z.string().optional().or(z.literal('')),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ ok: true, data: await staff.createStaff({ body: req.body, ...meta(req) }) });
  }),
);

superadminRoutes.patch(
  '/staff/:id',
  validate({
    body: z.object({
      name: z.string().min(2).max(80).optional(),
      phone: z.string().min(10).max(13).optional(),
      email: z.string().email().optional().or(z.literal('')),
      districtId: z.string().optional().or(z.literal('')),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await staff.updateStaff({ userId: req.params.id, patch: req.body, ...meta(req) }) });
  }),
);

superadminRoutes.post(
  '/staff/:id/password',
  validate({ body: z.object({ password: z.string().min(8).max(72).optional().or(z.literal('')), viaWhatsapp: z.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const data = req.body.viaWhatsapp
      ? await staff.sendPasswordResetOtp({ userId: req.params.id, ...meta(req) })
      : await staff.resetPassword({ userId: req.params.id, password: req.body.password || undefined, ...meta(req) });
    res.json({ ok: true, data });
  }),
);

superadminRoutes.post(
  '/staff/:id/deactivate',
  validate({ body: z.object({ reason: z.string().max(300).optional(), transferToUserId: z.string().optional().or(z.literal('')) }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await staff.deactivateStaff({
      userId: req.params.id, reason: req.body.reason, transferToUserId: req.body.transferToUserId || null, ...meta(req),
    }) });
  }),
);

superadminRoutes.post(
  '/staff/:id/reactivate',
  validate({ body: z.object({ districtId: z.string().optional().or(z.literal('')) }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await staff.reactivateStaff({ userId: req.params.id, districtId: req.body.districtId || null, ...meta(req) }) });
  }),
);

superadminRoutes.delete('/staff/:id', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await staff.deleteStaff({ userId: req.params.id, ...meta(req) }) });
}));

superadminRoutes.post(
  '/districts/:id/transfer',
  validate({ body: z.object({ toUserId: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await staff.transferDistrict({ districtId: req.params.id, toUserId: req.body.toUserId, ...meta(req) }) });
  }),
);

superadminRoutes.get('/districts/:id/load', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await staff.districtLoad(req.params.id) });
}));

// Legacy aliases kept so the existing Add Agent modal keeps working.
superadminRoutes.get('/users', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await staff.listStaff({ role: req.query.role }) });
}));

superadminRoutes.post('/users/:id/deactivate', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await staff.deactivateStaff({ userId: req.params.id, reason: req.body?.reason, ...meta(req) }) });
}));

// ---- WhatsApp / OTP runtime configuration ----
superadminRoutes.get('/wa-settings', asyncHandler(async (_req, res) => {
  const s = await getWaSettings({ fresh: true });
  // Never echo the auth key back to a browser.
  const { wabridgeAuthKey, ...safe } = s;
  res.json({ ok: true, data: { ...safe, wabridgeAuthKeySet: Boolean(wabridgeAuthKey) } });
}));

superadminRoutes.put(
  '/wa-settings',
  validate({
    body: z.object({
      enabled: z.boolean().optional(),
      provider: z.enum(['console', 'wabridge']).optional(),
      wabridgeBaseUrl: z.string().url().optional(),
      wabridgeAppKey: z.string().optional(),
      wabridgeAuthKey: z.string().optional(),
      wabridgeDeviceId: z.string().optional(),
      templateOtp: z.string().optional(),
      templateTokenBooked: z.string().optional(),
      templateTokenNearing: z.string().optional(),
      templateDoctorBreak: z.string().optional(),
      templateHospitalApproved: z.string().optional(),
      otpDemo: z.boolean().optional(),
      otpDemoCode: z.string().min(4).max(8).optional(),
      otpTtlMinutes: z.coerce.number().int().min(1).max(30).optional(),
      otpMaxAttempts: z.coerce.number().int().min(1).max(10).optional(),
      otpLength: z.coerce.number().int().min(4).max(8).optional(),
      require2faRoles: z.array(z.enum(Object.values(ROLES))).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const patch = { ...req.body, updatedBy: req.user.id };
    // An empty string means "leave it alone", not "clear it" — otherwise the UI
    // would wipe the key every time it saves an unrelated field.
    if (patch.wabridgeAuthKey === '') delete patch.wabridgeAuthKey;
    await WaSettings.findOneAndUpdate({ _id: 'singleton' }, { $set: patch }, { upsert: true });
    bustWaSettingsCache();
    writeAuditLog({
      actorId: req.user.id, actorRole: req.user.role, action: AUDIT_ACTIONS.WA_SETTINGS_UPDATED,
      entityType: 'WaSettings', after: { ...patch, wabridgeAuthKey: patch.wabridgeAuthKey ? '[set]' : undefined },
    });
    const s = await getWaSettings({ fresh: true });
    const { wabridgeAuthKey, ...safe } = s;
    res.json({ ok: true, data: { ...safe, wabridgeAuthKeySet: Boolean(wabridgeAuthKey) } });
  }),
);

superadminRoutes.get('/wa-settings/templates', asyncHandler(async (_req, res) => {
  const settings = await getWaSettings({ fresh: true });
  const driver = getDriver(settings.provider);
  const all = await driver.listTemplates({ settings });
  // Only APPROVED templates are messageable.
  res.json({ ok: true, data: all.filter((t) => String(t.status).toUpperCase() === 'APPROVED') });
}));

superadminRoutes.post(
  '/wa-settings/test',
  validate({ body: z.object({ phone: z.string().min(10), templateId: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const settings = await getWaSettings({ fresh: true });
    const driver = getDriver(settings.enabled ? settings.provider : 'console');
    const result = await driver.sendTemplate({
      to: req.body.phone,
      templateId: req.body.templateId || settings.templateOtp,
      variables: ['OTP', '1234'],
      settings,
    });
    res.json({ ok: true, data: { provider: settings.enabled ? settings.provider : 'console', ...result } });
  }),
);

// ---- Platform metrics ----
superadminRoutes.get('/metrics', asyncHandler(async (req, res) => {
  const day = req.query.date || clinicDate();
  const [hospitals, doctors, patients, tokensToday, revenueToday, byDistrict] = await Promise.all([
    Hospital.aggregate([{ $group: { _id: '$networkState', count: { $sum: 1 } } }]),
    Doctor.countDocuments({ isActive: true }),
    User.countDocuments({ role: ROLES.PATIENT }),
    OPDToken.countDocuments({ date: day }),
    Transaction.aggregate([
      { $match: { date: day, status: 'PAID' } },
      { $lookup: { from: 'opdtokens', localField: 'tokenId', foreignField: '_id', as: 't' } },
      { $unwind: '$t' },
      { $match: { 't.status': TOKEN_STATUS.COMPLETED } },
      { $group: { _id: null, cash: { $sum: '$tender.cash' }, upi: { $sum: '$tender.upi' }, card: { $sum: '$tender.card' }, total: { $sum: '$totalFee' } } },
    ]),
    Hospital.aggregate([
      { $group: { _id: '$districtId', hospitals: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$networkState', NETWORK_STATE.ACTIVE] }, 1, 0] } } } },
      { $lookup: { from: 'districts', localField: '_id', foreignField: '_id', as: 'd' } },
      { $unwind: '$d' },
      { $project: { district: '$d.name', code: '$d.code', cityTier: '$d.cityTier', hospitals: 1, active: 1 } },
    ]),
  ]);

  res.json({
    ok: true,
    data: {
      date: day,
      basis: 'COMPLETED_ONLY',
      hospitals: Object.fromEntries(hospitals.map((h) => [h._id, h.count])),
      doctors,
      patients,
      tokensToday,
      revenueToday: revenueToday[0] ?? { cash: 0, upi: 0, card: 0, total: 0 },
      byDistrict,
    },
  });
}));
