import { Router } from 'express';
import multer from 'multer';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, optionalAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { z } from 'zod';
import { ROLES, DOCTOR_DOC_TYPES, DOCTOR_DOC_LABEL, SHIFT } from '../../config/constants.js';
import { extendSitting, clearSittingExtension } from '../../services/absence.js';
import { assertDocType, storeDocument, readDocument, loadDoctorForDocs } from '../../services/kyc.js';
import { Doctor } from '../../models/index.js';
import { notFound } from '../../lib/errors.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { nearbySchema, slotsSchema, suggestSchema, placeResolveSchema, feesSchema, profileSchema, scheduleSchema, markOffSchema } from './schema.js';

export const doctorRoutes = Router();

// Memory storage, not disk: the upload is re-encoded by sharp immediately, so
// writing the caller's bytes to the filesystem first would add an unnecessary
// step AND leave attacker-controlled content on disk. The limit is enforced
// here as well as in the service so multer aborts a huge body mid-stream
// rather than buffering all of it first.
// Who may change a doctor's profile, fees, photo or weekly schedule. The
// front desk reads them but does not edit them; it keeps the day-to-day
// controls (bookings open/closed, marking a day off).
const PROFILE_EDITORS = [ROLES.DOCTOR, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

// Public — patients browse clinics before signing in.
doctorRoutes.get('/nearby', optionalAuth, validate(nearbySchema), asyncHandler(controller.nearby));

// Public too: the Explore filter needs this before anyone signs in.
doctorRoutes.get('/specialties', asyncHandler(controller.specialties));

// Type-ahead for the search box. Public for the same reason as /nearby.
doctorRoutes.get('/suggest', validate(suggestSchema), asyncHandler(controller.suggest));

// Cities with clinics, so a patient can browse a city instead of sharing GPS.
doctorRoutes.get('/cities', asyncHandler(controller.cities));

// Type-ahead for the location box: cities, localities and pincodes to search from.
doctorRoutes.get('/places', validate(suggestSchema), asyncHandler(controller.places));
// A picked Google suggestion -> coordinates. Public, like /places.
doctorRoutes.get('/places/resolve', validate(placeResolveSchema), asyncHandler(controller.resolvePlace));

doctorRoutes.get(
  '/',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  asyncHandler(controller.list),
);
// Public: profile URLs for the website's sitemap.xml (served by the frontend host).
doctorRoutes.get('/sitemap', asyncHandler(controller.sitemap));
// ---- Verification documents (Aadhaar, PAN, registration certificate) ----
// The doctor, their district admin and Super Admin may see them; the doctor
// or Super Admin may replace one. Never the front desk, never a public URL.
doctorRoutes.get('/:id/documents', requireAuth, asyncHandler(requireActiveUser), asyncHandler(async (req, res) => {
  const doctor = await loadDoctorForDocs(req.user, req.params.id);
  const byType = new Map((doctor.kycDocuments || []).map((d) => [d.type, d]));
  res.json({
    ok: true,
    data: DOCTOR_DOC_TYPES.map((type) => ({
      type,
      label: DOCTOR_DOC_LABEL[type],
      uploaded: byType.has(type),
      uploadedAt: byType.get(type)?.uploadedAt ?? null,
    })),
  });
}));
doctorRoutes.get('/:id/documents/:type/file', requireAuth, asyncHandler(requireActiveUser), asyncHandler(async (req, res) => {
  const type = assertDocType(req.params.type);
  const doctor = await loadDoctorForDocs(req.user, req.params.id);
  const doc = (doctor.kycDocuments || []).find((d) => d.type === type);
  if (!doc) throw notFound('Not uploaded yet');
  const { buf, contentType } = await readDocument(doc.objectPath);
  res.set({ 'Content-Type': contentType, 'Cache-Control': 'private, no-store' }).send(buf);
}));
doctorRoutes.put(
  '/:id/documents/:type',
  requireAuth, asyncHandler(requireActiveUser),
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const type = assertDocType(req.params.type);
    const doctor = await loadDoctorForDocs(req.user, req.params.id, { write: true });
    const objectPath = await storeDocument(req.file, `kyc/doctor-${doctor._id}`);
    const rest = (doctor.kycDocuments || []).filter((d) => d.type !== type);
    await Doctor.updateOne({ _id: doctor._id }, { $set: { kycDocuments: [...rest, { type, objectPath, uploadedAt: new Date() }] } });
    writeAuditLog({
      actorId: req.user.id, actorRole: req.user.role, action: 'DOCTOR_DOCUMENT_UPDATED',
      entityType: 'Doctor', entityId: doctor._id, hospitalId: doctor.hospitalId, after: { type },
    });
    res.json({ ok: true, data: { type, uploaded: true, uploadedAt: new Date() } });
  }),
);

doctorRoutes.get('/:id', optionalAuth, asyncHandler(controller.getById));

doctorRoutes.patch(
  '/:id/fees',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(...PROFILE_EDITORS),
  validate(feesSchema), asyncHandler(controller.updateFees),
);
// The clinic's front desk keeps its doctors' profiles current, so
// receptionists may edit too — assertDoctorScope confines them to their own
// clinic, and the service keeps registration details locked.
doctorRoutes.patch(
  '/:id',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(...PROFILE_EDITORS),
  validate(profileSchema), asyncHandler(controller.updateProfile),
);

// ---- Profile photo ----
// Receptionists included on purpose: the front desk is usually who has the
// photo to hand, and assertDoctorScope already confines them to their own
// clinic. A doctor may only change their own.
doctorRoutes.put(
  '/:id/photo',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(...PROFILE_EDITORS),
  upload.single('photo'), asyncHandler(controller.setPhoto),
);
doctorRoutes.delete(
  '/:id/photo',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(...PROFILE_EDITORS),
  asyncHandler(controller.removePhoto),
);

// ---- Scheduling ----
// Public: a patient picking a date needs this before they sign in.
doctorRoutes.get('/:id/availability', optionalAuth, asyncHandler(controller.availability));
doctorRoutes.get('/:id/slots', optionalAuth, validate(slotsSchema), asyncHandler(controller.slots));

doctorRoutes.put(
  '/:id/schedule',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(...PROFILE_EDITORS),
  validate(scheduleSchema), asyncHandler(controller.updateSchedule),
);

// The clinic's front desk marks a doctor off as often as the doctor does.
doctorRoutes.post(
  '/:id/off',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(markOffSchema), asyncHandler(controller.markOff),
);
// Keep today's sitting open longer (+15 / +30 / +60 min), or undo it.
doctorRoutes.post(
  '/:id/extend',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate({ body: z.object({ shift: z.enum(Object.values(SHIFT)), minutes: z.coerce.number().int().refine((m) => [15, 30, 60].includes(m), 'Extend by 15, 30 or 60 minutes') }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await extendSitting({ doctorId: req.params.id, shift: req.body.shift, minutes: req.body.minutes, actor: req.user }) });
  }),
);
doctorRoutes.post(
  '/:id/extend/clear',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate({ body: z.object({ shift: z.enum(Object.values(SHIFT)) }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await clearSittingExtension({ doctorId: req.params.id, shift: req.body.shift, actor: req.user }) });
  }),
);
doctorRoutes.post(
  '/:id/off/clear',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(markOffSchema), asyncHandler(controller.clearOff),
);
