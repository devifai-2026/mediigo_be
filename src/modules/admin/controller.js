import * as service from './service.js';

const meta = (req) => ({ actor: req.user, ip: req.ip, userAgent: req.headers['user-agent'] });

export const listApprovals = async (req, res) => {
  const data = await service.listApprovals({ actor: req.user, status: req.query.status });
  res.json({ ok: true, data });
};
export const approve = async (req, res) => {
  const data = await service.approveSubmission({ submissionId: req.params.id, ...meta(req) });
  res.json({ ok: true, data });
};
export const reject = async (req, res) => {
  const data = await service.rejectSubmission({ submissionId: req.params.id, reason: req.body.reason, ...meta(req) });
  res.json({ ok: true, data });
};
export const listHospitals = async (req, res) => {
  const data = await service.listHospitals({ actor: req.user, networkState: req.query.networkState, search: req.query.search });
  res.json({ ok: true, data });
};
export const suspend = async (req, res) => {
  const data = await service.suspendHospital({ hospitalId: req.params.id, reason: req.body.reason, ...meta(req) });
  res.json({ ok: true, data });
};
export const reactivate = async (req, res) => {
  const data = await service.reactivateHospital({ hospitalId: req.params.id, ...meta(req) });
  res.json({ ok: true, data });
};
export const deboard = async (req, res) => {
  const data = await service.deboardHospital({
    hospitalId: req.params.id, reason: req.body.reason, force: Boolean(req.body.force), ...meta(req),
  });
  res.json({ ok: true, data });
};
export const pendingRefunds = async (req, res) => {
  const data = await service.listPendingRefunds({ hospitalId: req.params.id, actor: req.user });
  res.json({ ok: true, data });
};
export const deboardDoctor = async (req, res) => {
  const data = await service.deboardDoctor({ doctorId: req.params.id, reason: req.body.reason, ...meta(req) });
  res.json({ ok: true, data });
};
export const audit = async (req, res) => {
  const data = await service.getAudit({ actor: req.user, ...req.query });
  res.json({ ok: true, data });
};
export const dashboard = async (req, res) => {
  const data = await service.dashboard({ actor: req.user, date: req.query.date });
  res.json({ ok: true, data });
};
