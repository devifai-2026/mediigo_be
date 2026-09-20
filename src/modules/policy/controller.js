import * as service from './service.js';

export const lookup = async (req, res) => {
  const data = await service.lookupVault({ aadhaarNumber: req.body.aadhaarNumber, actor: req.user });
  res.json({ ok: true, data });
};

export const list = async (req, res) => {
  const data = await service.listPolicies({ aadhaarHash: req.params.aadhaarHash, actor: req.user });
  res.json({ ok: true, data });
};

export const gapAnalysis = async (req, res) => {
  const data = await service.gapAnalysis({ aadhaarHash: req.params.aadhaarHash, actor: req.user });
  res.json({ ok: true, data });
};

export const add = async (req, res) => {
  const data = await service.addPolicy({ body: req.body, actor: req.user });
  res.status(201).json({ ok: true, data });
};

export const update = async (req, res) => {
  const data = await service.updatePolicy({ policyId: req.params.id, patch: req.body, actor: req.user });
  res.json({ ok: true, data });
};
