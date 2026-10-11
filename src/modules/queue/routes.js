import { Router } from 'express';
import { z } from 'zod';
import * as controller from './controller.js';
import { OPDToken, Doctor, Hospital } from '../../models/index.js';
import { buildQueueSnapshot } from '../../services/queueSnapshot.js';
import { notFound } from '../../lib/errors.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, optionalAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES, TOKEN_STATUS } from '../../config/constants.js';
import {
  queryDate, statusSchema, breakSchema, bookSchema, bookingOpenSchema, rescheduleSchema,
  followUpSchema, followUpRespondSchema, followUpReleaseSchema,
} from './schema.js';
import {
  followUpOptions, scheduleFollowUp, respondToFollowUp, releaseFollowUp, listFollowUps,
} from '../../services/followUps.js';
import { shiftsOn, closureReason } from '../../services/availability.js';
import { clinicDate } from '../../lib/dates.js';
import { forbidden } from '../../lib/errors.js';

export const queueRoutes = Router();

const DESK = [ROLES.DOCTOR, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN];

/**
 * Today's roster for the caller's clinic: every doctor, their sittings, how
 * full each sitting is, and whether the doctor is taking bookings right now.
 *
 * Declared before '/:doctorId' only for readability — it has two segments, so
 * it could never be mistaken for a doctor id.
 */
queueRoutes.get(
  '/roster/today',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  asyncHandler(async (req, res) => {
    const hospitalId = req.user.hospitalId || req.query.hospitalId;
    if (!hospitalId) throw forbidden('No clinic in scope');
    const hospital = await Hospital.findById(hospitalId).select('name timezone').lean();
    if (!hospital) throw notFound('Clinic not found');
    const date = clinicDate(hospital.timezone);

    const doctors = await Doctor.find({ hospitalId, isActive: true })
      .select('name specialty chamberNumber photo.url session schedule scheduleOverrides avgConsultMinutes')
      .sort({ name: 1 })
      .lean();
    const counts = await OPDToken.aggregate([
      { $match: { hospitalId: hospital._id, date, status: { $nin: [TOKEN_STATUS.CANCELLED, TOKEN_STATUS.RESCHEDULE_NEEDED] } } },
      {
        $group: {
          _id: { doctorId: '$doctorId', shift: '$shift' },
          booked: { $sum: 1 },
          waiting: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.WAITING] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.COMPLETED] }, 1, 0] } },
          inChamber: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.IN_CHAMBER] }, 1, 0] } },
        },
      },
    ]);
    const countOf = new Map(counts.map((c) => [`${c._id.doctorId}:${c._id.shift}`, c]));

    res.json({
      ok: true,
      data: {
        date,
        hospitalName: hospital.name,
        doctors: doctors.map((d) => {
          const shifts = shiftsOn(d, date).map((sh) => {
            const c = countOf.get(`${d._id}:${sh.shift}`) || {};
            return {
              shift: sh.shift,
              startTime: sh.startTime,
              endTime: sh.endTime,
              maxTokens: sh.maxTokens,
              source: sh.source,
              booked: c.booked ?? 0,
              waiting: c.waiting ?? 0,
              completed: c.completed ?? 0,
              inChamber: c.inChamber ?? 0,
            };
          });
          return {
            doctorId: String(d._id),
            name: d.name,
            specialty: d.specialty || '',
            chamberNumber: d.chamberNumber || '',
            photoUrl: d.photo?.url || null,
            avgConsultMinutes: d.avgConsultMinutes || 8,
            session: {
              isBookingOpen: Boolean(d.session?.isBookingOpen),
              isOnBreak: Boolean(d.session?.isOnBreak),
              breakReason: d.session?.breakReason ?? null,
              breakUntil: d.session?.breakUntil ?? null,
            },
            offReason: shifts.length ? null : closureReason(d, date),
            shifts,
          };
        }),
      },
    });
  }),
);

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
// Patients cancel their own; clinic staff cancel with a reason (enforced in
// the service, which knows who is asking).
queueRoutes.delete(
  '/tokens/:tokenId',
  requireAuth, asyncHandler(requireActiveUser),
  validate({ body: z.object({ reason: z.string().trim().max(200).optional() }).optional() }),
  asyncHandler(controller.cancel),
);
// The doctor has seen a cancellation someone else made on their list.
queueRoutes.post(
  '/tokens/:tokenId/cancel-ack',
  requireAuth, asyncHandler(requireActiveUser), requireRole(ROLES.DOCTOR, ROLES.SUPER_ADMIN),
  asyncHandler(controller.cancelAck),
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

// ---- Doctor-booked follow-ups (see services/followUps.js) ----
queueRoutes.get(
  '/:doctorId/followup-options',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await followUpOptions({ doctorId: req.params.doctorId, actor: req.user }) });
  }),
);
queueRoutes.get(
  '/:doctorId/followups',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await listFollowUps({ doctorId: req.params.doctorId, actor: req.user }) });
  }),
);
queueRoutes.post(
  '/tokens/:tokenId/followup',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  validate(followUpSchema),
  asyncHandler(async (req, res) => {
    const data = await scheduleFollowUp({
      sourceTokenId: req.params.tokenId, date: req.body.date, shift: req.body.shift, note: req.body.note, actor: req.user,
    });
    res.status(201).json({ ok: true, data });
  }),
);
queueRoutes.post(
  '/tokens/:tokenId/followup/respond',
  requireAuth, asyncHandler(requireActiveUser), requireRole(ROLES.PATIENT),
  validate(followUpRespondSchema),
  asyncHandler(async (req, res) => {
    const data = await respondToFollowUp({ tokenId: req.params.tokenId, attending: req.body.attending, actor: req.user });
    res.json({ ok: true, data });
  }),
);
queueRoutes.post(
  '/tokens/:tokenId/followup/release',
  requireAuth, asyncHandler(requireActiveUser), requireRole(...DESK),
  validate(followUpReleaseSchema),
  asyncHandler(async (req, res) => {
    const data = await releaseFollowUp({ tokenId: req.params.tokenId, reason: req.body?.reason, actor: req.user });
    res.json({ ok: true, data });
  }),
);
