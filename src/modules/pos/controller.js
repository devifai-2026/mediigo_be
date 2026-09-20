import * as service from './service.js';

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
  const data = await service.dayClose({
    hospitalId: req.user.hospitalId,
    date: req.query.date,
    actor: req.user,
  });
  res.json({ ok: true, data });
};
