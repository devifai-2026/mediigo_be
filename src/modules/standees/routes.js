import { Router } from 'express';
import { z } from 'zod';
import { QRStandee, Hospital, Doctor } from '../../models/index.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole, scopeFilter } from '../../middleware/rbac.js';
import { notFound, conflict, gone } from '../../lib/errors.js';
import { signStandeeToken, randomToken } from '../../lib/crypto.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { ROLES, STANDEE_STATUS, NETWORK_STATE, AUDIT_ACTIONS } from '../../config/constants.js';

export const standeeRoutes = Router();

/**
 * Public QR landing. A deboarded clinic returns 410 Gone with an explanation
 * rather than a bare 404 — someone is standing in front of the poster.
 */
standeeRoutes.get('/scan/:serialId', asyncHandler(async (req, res) => {
  const standee = await QRStandee.findOne({ serialId: req.params.serialId.toUpperCase() }).select('+qrSecret').lean();
  if (!standee) throw notFound('Unknown QR code');

  if (!standee.hospitalId || standee.status === STANDEE_STATUS.RECLAIMED) {
    throw gone('This clinic is no longer on Mediigo', { serialId: standee.serialId });
  }

  const hospital = await Hospital.findById(standee.hospitalId)
    .select('name code address location networkState contactPhone').lean();
  if (!hospital || hospital.networkState === NETWORK_STATE.DEBOARDED) {
    throw gone('This clinic is no longer on Mediigo');
  }
  if (hospital.networkState !== NETWORK_STATE.ACTIVE) {
    throw conflict('This clinic is temporarily not accepting bookings');
  }

  QRStandee.updateOne({ _id: standee._id }, { $inc: { scanCount: 1 }, $set: { lastScanAt: new Date() } }).catch(() => {});

  const doctors = await Doctor.find({ hospitalId: hospital._id, isActive: true })
    .select('name specialty fees chamberNumber session').lean();

  res.json({
    ok: true,
    data: {
      hospital,
      doctors,
      // Lets a waiting-room display authenticate its socket without a login.
      displayToken: signStandeeToken(standee.serialId, standee.qrSecret),
    },
  });
}));

standeeRoutes.use(requireAuth, asyncHandler(requireActiveUser));

standeeRoutes.post(
  '/batch',
  requireRole(ROLES.SUPER_ADMIN),
  validate({ body: z.object({ count: z.coerce.number().int().min(1).max(500), batchCode: z.string().max(40) }) }),
  asyncHandler(async (req, res) => {
    const last = await QRStandee.findOne().sort({ serialId: -1 }).select('serialId').lean();
    const start = last ? Number(String(last.serialId).split('-').pop()) : 0;
    const docs = Array.from({ length: req.body.count }, (_, i) => ({
      serialId: `MG-STD-${String(start + i + 1).padStart(6, '0')}`,
      qrSecret: randomToken(24),
      batchCode: req.body.batchCode,
      status: STANDEE_STATUS.UNASSIGNED,
    }));
    const created = await QRStandee.insertMany(docs);
    res.status(201).json({ ok: true, data: { created: created.length, from: docs[0].serialId, to: docs.at(-1).serialId } });
  }),
);

standeeRoutes.get('/', asyncHandler(async (req, res) => {
  const scope = scopeFilter(req.user);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (scope.districtId) {
    const ids = await Hospital.find({ districtId: scope.districtId }).select('_id').lean();
    filter.$or = [{ hospitalId: { $in: ids.map((h) => h._id) } }, { hospitalId: null }];
  }
  res.json({ ok: true, data: await QRStandee.find(filter).sort({ serialId: 1 }).limit(500).lean() });
}));

standeeRoutes.post(
  '/:serialId/deploy',
  requireRole(ROLES.FIELD_AGENT, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  validate({ body: z.object({ hospitalId: z.string(), doctorId: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const standee = await QRStandee.findOne({ serialId: req.params.serialId.toUpperCase() });
    if (!standee) throw notFound('Standee not found');
    if (standee.status === STANDEE_STATUS.DEPLOYED) throw conflict('This standee is already deployed');

    await QRStandee.updateOne(
      { _id: standee._id },
      {
        $set: {
          hospitalId: req.body.hospitalId, doctorId: req.body.doctorId ?? null,
          status: STANDEE_STATUS.DEPLOYED, deployedAt: new Date(), deployedBy: req.user.id,
        },
      },
    );
    writeAuditLog({
      actorId: req.user.id, actorRole: req.user.role, action: AUDIT_ACTIONS.STANDEE_DEPLOYED,
      entityType: 'QRStandee', entityId: standee._id, hospitalId: req.body.hospitalId,
    });
    res.json({ ok: true, data: await QRStandee.findById(standee._id).lean() });
  }),
);

standeeRoutes.post(
  '/:serialId/reclaim',
  requireRole(ROLES.FIELD_AGENT, ROLES.EXEC_ADMIN, ROLES.SUPER_ADMIN),
  asyncHandler(async (req, res) => {
    const standee = await QRStandee.findOne({ serialId: req.params.serialId.toUpperCase() });
    if (!standee) throw notFound('Standee not found');
    await QRStandee.updateOne(
      { _id: standee._id },
      {
        $set: {
          status: STANDEE_STATUS.RECLAIMED, reclaimedAt: new Date(),
          reclaimReason: req.body?.reason || 'Manual reclaim',
          lastHospitalId: standee.hospitalId, hospitalId: null, doctorId: null,
        },
      },
    );
    writeAuditLog({
      actorId: req.user.id, actorRole: req.user.role, action: AUDIT_ACTIONS.STANDEE_RECLAIMED,
      entityType: 'QRStandee', entityId: standee._id, hospitalId: standee.hospitalId,
    });
    res.json({ ok: true, data: await QRStandee.findById(standee._id).lean() });
  }),
);
