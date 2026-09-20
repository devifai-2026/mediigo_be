import * as service from './service.js';

export const nearby = async (req, res) => {
  const data = await service.nearby(req.query);
  res.json({ ok: true, ...data });
};

export const getById = async (req, res) => {
  const data = await service.getById(req.params.id);
  res.json({ ok: true, data });
};

export const list = async (req, res) => {
  const data = await service.list(req.user);
  res.json({ ok: true, data });
};

export const updateFees = async (req, res) => {
  const data = await service.updateFees({ doctorId: req.params.id, fees: req.body, actor: req.user });
  res.json({ ok: true, data });
};

export const updateProfile = async (req, res) => {
  const data = await service.updateProfile({ doctorId: req.params.id, patch: req.body, actor: req.user });
  res.json({ ok: true, data });
};
