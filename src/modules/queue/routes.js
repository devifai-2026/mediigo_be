import { Router } from 'express';
import * as controller from './controller.js';
import { OPDToken, Doctor, Hospital } from '../../models/index.js';
import { buildQueueSnapshot } from '../../services/queueSnapshot.js';
import { notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, optionalAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES, TOKEN_STATUS } from '../../config/constants.js';
import { queryDate, statusSchema, breakSchema, bookSchema, bookingOpenSchema, rescheduleSchema } from './schema.js';

export const queueRoutes = Router();

const DESK = [ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN];

// Public: a waiting-room display or a patient checking progress. Names are
// masked for anyone who is not staff.
queueRoutes.get('/:doctorId', optionalAuth, validate(queryDate), asyncHandler(controller.getQueue));

queueRoutes.post(
  '/:doctorId/call-next',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  asyncHandler(controller.callNext),
);
queueRoutes.post(
  '/:doctorId/recall',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  asyncHandler(controller.recall),
);
queueRoutes.post(
  '/:doctorId/break',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  validate(breakSchema), asyncHandler(controller.startBreak),
);
queueRoutes.post(
  '/:doctorId/resume',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  asyncHandler(controller.endBreak),
);
queueRoutes.post(
  '/:doctorId/booking',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  validate(bookingOpenSchema), asyncHandler(controller.setBookingOpen),
);

queueRoutes.post(
  '/tokens/:tokenId/status',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  validate(statusSchema), asyncHandler(controller.setStatus),
);
queueRoutes.post(
  '/tokens/:tokenId/restore',
  requireAuth, asyncHandler(requireActiveUser), requireRole(ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.SUPER_ADMIN),
  asyncHandler(controller.restore),
);

/**
 * Public live status for one token.
 *
 * A walk-in has no app and no login — they were handed a paper slip at the
 * desk — so this is reachable without auth. It is deliberately thin: the
 * token id is an opaque ObjectId, and the response carries only what is
 * already printed on that patient's own slip plus the public queue position.
 * No phone number, no other patient's name, nothing a stranger guessing ids
 * could harvest.
 */
queueRoutes.get(
  '/track/:tokenId',
  asyncHandler(async (req, res) => {
    const token = await OPDToken.findById(req.params.tokenId)
      .select('tokenNumber status date doctorId hospitalId patientSnapshot.name shift')
      .lean()
      .catch(() => null);
    if (!token) throw notFound('Token not found');

    const [doctor, hospital, snapshot] = await Promise.all([
      Doctor.findById(token.doctorId).select('name specialty chamberNumber session').lean(),
      Hospital.findById(token.hospitalId).select('name contactPhone').lean(),
      buildQueueSnapshot(token.doctorId, token.date, { includePii: false }),
    ]);

    const ahead = (snapshot?.tokens || []).filter(
      (t) => t.status === TOKEN_STATUS.WAITING && t.tokenNumber < token.tokenNumber,
    ).length;

    res.json({
      ok: true,
      data: {
        tokenNumber: token.tokenNumber,
        status: token.status,
        date: token.date,
        patientName: token.patientSnapshot?.name || '',
        doctorName: doctor?.name || '',
        specialty: doctor?.specialty || '',
        chamberNumber: doctor?.chamberNumber || '',
        hospitalName: hospital?.name || '',
        contactPhone: hospital?.contactPhone || '',
        nowServing: snapshot?.currentToken ?? 0,
        ahead,
        // Null while the doctor is on a break: the queue is not advancing, so
        // any number here would be a guess presented as a countdown.
        estimatedWaitMinutes: snapshot?.session?.isOnBreak
          ? null
          : ahead * (snapshot?.avgConsultMinutes || 8),
        isOnBreak: Boolean(snapshot?.session?.isOnBreak),
        totalWaiting: snapshot?.counts?.waiting ?? 0,
      },
    });
  }),
);

queueRoutes.post(
  '/book',
  requireAuth, asyncHandler(requireActiveUser), requireRole(ROLES.PATIENT),
  validate(bookSchema), asyncHandler(controller.book),
);
queueRoutes.delete(
  '/tokens/:tokenId',
  requireAuth, asyncHandler(requireActiveUser),
  asyncHandler(controller.cancel),
);

// ---- Reschedule: a doctor went off and this patient must move ----
queueRoutes.get(
  '/tokens/:tokenId/reschedule-options',
  requireAuth, asyncHandler(requireActiveUser),
  asyncHandler(controller.rescheduleChoices),
);
queueRoutes.post(
  '/tokens/:tokenId/reschedule',
  requireAuth, asyncHandler(requireActiveUser),
  validate(rescheduleSchema), asyncHandler(controller.reschedule),
);
