import * as service from './service.js';
import { reportDoctorId } from './desk.js';
import { validationError } from '../../lib/errors.js';

const meta = (req) => ({ actor: req.user, ip: req.ip, userAgent: req.headers['user-agent'] });

export const walkin = async (req, res) => {
  const result = await service.createWalkin({ body: req.body, ...meta(req) });
  res.status(result.idempotentReplay ? 200 : 201).json({ ok: true, data: result });
};

export const pay = async (req, res) => {
  const data = await service.payForToken({ tokenId: req.params.tokenId, body: req.body, ...meta(req) });
  res.json({ ok: true, data });
};

export const dayClose = async (req, res) => {
  // Desk staff are pinned to their own clinic; an admin names one, and
  // dayClose's assertHospitalScope keeps a district admin inside their district.
  const hospitalId = req.user.hospitalId || req.query.hospitalId;
  if (!hospitalId) throw validationError([{ path: 'query.hospitalId', message: 'Pick a clinic' }]);
  const data = await service.dayClose({
    hospitalId,
    date: req.query.date,
    actor: req.user,
    doctorId: await reportDoctorId(req.user, req.query.doctorId),
  });
  res.json({ ok: true, data });
};
