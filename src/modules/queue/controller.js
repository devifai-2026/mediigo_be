import * as service from './service.js';
import { rescheduleOptions, rescheduleToken } from '../../services/absence.js';

export const getQueue = async (req, res) => {
  const data = await service.getQueue({ doctorId: req.params.doctorId, date: req.query.date, actor: req.user });
  res.json({ ok: true, data });
};

export const callNext = async (req, res) => {
  const data = await service.callNext({ doctorId: req.params.doctorId, actor: req.user });
  res.json({ ok: true, data });
};

export const recall = async (req, res) => {
  const data = await service.recall({ doctorId: req.params.doctorId, actor: req.user });
  res.json({ ok: true, data });
};

export const setStatus = async (req, res) => {
  const data = await service.setTokenStatus({
    tokenId: req.params.tokenId, to: req.body.status, reason: req.body.reason, actor: req.user,
  });
  res.json({ ok: true, data });
};

export const restore = async (req, res) => {
  const data = await service.restoreSkipped({ tokenId: req.params.tokenId, actor: req.user });
  res.json({ ok: true, data });
};

export const startBreak = async (req, res) => {
  const data = await service.startBreak({
    doctorId: req.params.doctorId, reason: req.body.reason, minutes: req.body.minutes, actor: req.user,
  });
  res.json({ ok: true, data });
};

export const endBreak = async (req, res) => {
  const data = await service.endBreak({ doctorId: req.params.doctorId, actor: req.user });
  res.json({ ok: true, data });
};

export const setBookingOpen = async (req, res) => {
  const data = await service.setBookingOpen({
    doctorId: req.params.doctorId, isOpen: req.body.isOpen, actor: req.user,
  });
  res.json({ ok: true, data });
};

export const book = async (req, res) => {
  const data = await service.bookToken({
    doctorId: req.body.doctorId,
    patientId: req.user.id,
    familyMemberId: req.body.familyMemberId,
    visitType: req.body.visitType,
    date: req.body.date,
    shift: req.body.shift,
    complaint: req.body.complaint,
    actor: req.user,
  });
  res.status(201).json({ ok: true, data });
};

export const cancel = async (req, res) => {
  const data = await service.cancelToken({ tokenId: req.params.tokenId, actor: req.user });
  res.json({ ok: true, data });
};

// ---- Reschedule after a doctor goes off ----

export const rescheduleChoices = async (req, res) => {
  const data = await rescheduleOptions({ tokenId: req.params.tokenId });
  res.json({ ok: true, data });
};

export const reschedule = async (req, res) => {
  const data = await rescheduleToken({
    tokenId: req.params.tokenId, date: req.body.date, shift: req.body.shift, actor: req.user,
  });
  res.status(200).json({ ok: true, data });
};
