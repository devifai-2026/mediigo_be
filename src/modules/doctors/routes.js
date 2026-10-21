import { Router } from 'express';
import multer from 'multer';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, optionalAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';
import { nearbySchema, slotsSchema, suggestSchema, feesSchema, profileSchema, scheduleSchema, markOffSchema } from './schema.js';

export const doctorRoutes = Router();

// Memory storage, not disk: the upload is re-encoded by sharp immediately, so
// writing the caller's bytes to the filesystem first would add an unnecessary
// step AND leave attacker-controlled content on disk. The limit is enforced
// here as well as in the service so multer aborts a huge body mid-stream
// rather than buffering all of it first.
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

doctorRoutes.get(
  '/',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  asyncHandler(controller.list),
);
// Public: profile URLs for the website's sitemap.xml (served by the frontend host).
doctorRoutes.get('/sitemap', asyncHandler(controller.sitemap));
doctorRoutes.get('/:id', optionalAuth, asyncHandler(controller.getById));

doctorRoutes.patch(
  '/:id/fees',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(feesSchema), asyncHandler(controller.updateFees),
);
// The clinic's front desk keeps its doctors' profiles current, so
// receptionists may edit too — assertDoctorScope confines them to their own
// clinic, and the service keeps registration details locked.
doctorRoutes.patch(
  '/:id',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(profileSchema), asyncHandler(controller.updateProfile),
);

// ---- Profile photo ----
// Receptionists included on purpose: the front desk is usually who has the
// photo to hand, and assertDoctorScope already confines them to their own
// clinic. A doctor may only change their own.
doctorRoutes.put(
  '/:id/photo',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  upload.single('photo'), asyncHandler(controller.setPhoto),
);
doctorRoutes.delete(
  '/:id/photo',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  asyncHandler(controller.removePhoto),
);

// ---- Scheduling ----
// Public: a patient picking a date needs this before they sign in.
doctorRoutes.get('/:id/availability', optionalAuth, asyncHandler(controller.availability));
doctorRoutes.get('/:id/slots', optionalAuth, validate(slotsSchema), asyncHandler(controller.slots));

doctorRoutes.put(
  '/:id/schedule',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(scheduleSchema), asyncHandler(controller.updateSchedule),
);

// The clinic's front desk marks a doctor off as often as the doctor does.
doctorRoutes.post(
  '/:id/off',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(markOffSchema), asyncHandler(controller.markOff),
);
doctorRoutes.post(
  '/:id/off/clear',
  requireAuth, asyncHandler(requireActiveUser),
  requireRole(ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate(markOffSchema), asyncHandler(controller.clearOff),
);
