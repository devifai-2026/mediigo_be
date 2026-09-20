import { SOCKET_EVENTS } from '../config/constants.js';
import { chamberRoom, chamberPublicRoom, hospitalRoom, districtRoom, patientRoom, PLATFORM_ROOM } from './rooms.js';
import { buildQueueSnapshot } from '../services/queueSnapshot.js';
import { logger } from '../lib/logger.js';
import { randomUUID } from '../lib/crypto.js';

let io = null;

export const setIo = (instance) => {
  io = instance;
};

export const getIo = () => io;

// Emitters are ALWAYS called after a transaction commits, never inside one. An
// aborted transaction must not have announced a token number to a waiting room.
const safeEmit = (room, event, payload) => {
  if (!io) return;
  try {
    io.to(room).emit(event, payload);
  } catch (err) {
    logger.warn({ err, room, event }, 'socket emit failed');
  }
};

export const emitQueueSnapshot = async (doctorId, date) => {
  if (!io) return;
  const [staff, publicView] = await Promise.all([
    buildQueueSnapshot(doctorId, date, { includePii: true }),
    buildQueueSnapshot(doctorId, date, { includePii: false }),
  ]);
  if (!staff) return;
  safeEmit(chamberRoom(doctorId), SOCKET_EVENTS.QUEUE_SNAPSHOT, staff);
  safeEmit(chamberPublicRoom(doctorId), SOCKET_EVENTS.QUEUE_SNAPSHOT, publicView);
  safeEmit(hospitalRoom(staff.hospitalId), SOCKET_EVENTS.QUEUE_SNAPSHOT, staff);
};

export const emitTokenCreated = (token) => {
  const payload = {
    tokenId: String(token._id),
    tokenNumber: token.tokenNumber,
    doctorId: String(token.doctorId),
    date: token.date,
    source: token.source,
  };
  safeEmit(chamberRoom(token.doctorId), SOCKET_EVENTS.TOKEN_CREATED, payload);
  safeEmit(hospitalRoom(token.hospitalId), SOCKET_EVENTS.TOKEN_CREATED, payload);
};

export const emitTokenStatusChanged = ({ token, from, to, reason }) => {
  const payload = {
    tokenId: String(token._id),
    tokenNumber: token.tokenNumber,
    doctorId: String(token.doctorId),
    from,
    to,
    reason: reason ?? null,
    at: new Date().toISOString(),
  };
  safeEmit(chamberRoom(token.doctorId), SOCKET_EVENTS.TOKEN_STATUS_CHANGED, payload);
  safeEmit(hospitalRoom(token.hospitalId), SOCKET_EVENTS.TOKEN_STATUS_CHANGED, payload);
  safeEmit(patientRoom(token.patientId), SOCKET_EVENTS.TOKEN_STATUS_CHANGED, payload);
};

/**
 * CALL_NEXT_TOKEN is state (the board re-renders). EXECUTE_AUDIO_ANNOUNCEMENT is
 * a command (the speaker speaks). They stay separate so a recall can re-announce
 * without re-transitioning state, and a silent display can ignore the audio.
 * announcementId lets a device that receives a duplicate dedupe rather than
 * shouting the same token twice.
 */
export const emitCallNext = ({ token, doctor, recall = false }) => {
  const announcementId = randomUUID();
  const chamberNumber = doctor.chamberNumber || '';

  safeEmit(chamberRoom(token.doctorId), SOCKET_EVENTS.CALL_NEXT_TOKEN, {
    tokenId: String(token._id),
    tokenNumber: token.tokenNumber,
    patientName: token.patientSnapshot?.name ?? '',
    chamberNumber,
    doctorName: doctor.name,
    recall,
    calledAt: new Date().toISOString(),
    announcementId,
  });

  const spoken = `Token number ${token.tokenNumber}, please proceed to Chamber ${chamberNumber}.`;
  const audio = {
    announcementId,
    tokenNumber: token.tokenNumber,
    chamberNumber,
    doctorName: doctor.name,
    text: { en: spoken },
    lang: 'en-IN',
    repeat: 1,
  };
  safeEmit(chamberRoom(token.doctorId), SOCKET_EVENTS.EXECUTE_AUDIO_ANNOUNCEMENT, audio);
  safeEmit(chamberPublicRoom(token.doctorId), SOCKET_EVENTS.EXECUTE_AUDIO_ANNOUNCEMENT, audio);
};

export const emitDoctorBreak = (doctor) => {
  const payload = {
    doctorId: String(doctor._id),
    isOnBreak: Boolean(doctor.session?.isOnBreak),
    breakReason: doctor.session?.breakReason ?? null,
    breakUntil: doctor.session?.breakUntil ?? null,
  };
  safeEmit(chamberRoom(doctor._id), SOCKET_EVENTS.DOCTOR_BREAK_TOGGLE, payload);
  safeEmit(chamberPublicRoom(doctor._id), SOCKET_EVENTS.DOCTOR_BREAK_TOGGLE, payload);
  safeEmit(hospitalRoom(doctor.hospitalId), SOCKET_EVENTS.DOCTOR_BREAK_TOGGLE, payload);
};

export const emitDoctorSession = (doctor) => {
  const payload = { doctorId: String(doctor._id), isBookingOpen: Boolean(doctor.session?.isBookingOpen) };
  safeEmit(chamberRoom(doctor._id), SOCKET_EVENTS.DOCTOR_SESSION_CHANGED, payload);
  safeEmit(hospitalRoom(doctor.hospitalId), SOCKET_EVENTS.DOCTOR_SESSION_CHANGED, payload);
};

export const emitHospitalState = ({ hospital, from, to, reason }) => {
  const payload = { hospitalId: String(hospital._id), from, to, reason: reason ?? null, at: new Date().toISOString() };
  safeEmit(hospitalRoom(hospital._id), SOCKET_EVENTS.HOSPITAL_STATE_CHANGED, payload);
  safeEmit(districtRoom(hospital.districtId), SOCKET_EVENTS.HOSPITAL_STATE_CHANGED, payload);
  safeEmit(PLATFORM_ROOM, SOCKET_EVENTS.HOSPITAL_STATE_CHANGED, payload);
};

export const emitHospitalDeboarded = ({ hospital, reason, impact, doctorIds = [] }) => {
  const payload = { hospitalId: String(hospital._id), reason, impact, at: new Date().toISOString() };
  safeEmit(hospitalRoom(hospital._id), SOCKET_EVENTS.HOSPITAL_DEBOARDED, payload);
  safeEmit(districtRoom(hospital.districtId), SOCKET_EVENTS.HOSPITAL_DEBOARDED, payload);
  safeEmit(PLATFORM_ROOM, SOCKET_EVENTS.HOSPITAL_DEBOARDED, payload);
  doctorIds.forEach((id) => safeEmit(chamberRoom(id), SOCKET_EVENTS.HOSPITAL_DEBOARDED, payload));
};

export const emitSubmissionStatus = ({ submission, from, to }) => {
  const payload = {
    submissionId: String(submission._id),
    kind: submission.kind,
    from,
    to,
    reviewNotes: submission.reviewNotes ?? null,
  };
  safeEmit(districtRoom(submission.districtId), SOCKET_EVENTS.SUBMISSION_STATUS_CHANGED, payload);
  safeEmit(patientRoom(submission.agentId), SOCKET_EVENTS.SUBMISSION_STATUS_CHANGED, payload);
};

export const emitTransactionRecorded = ({ transaction, tokenNumber }) => {
  safeEmit(hospitalRoom(transaction.hospitalId), SOCKET_EVENTS.TRANSACTION_RECORDED, {
    transactionId: String(transaction._id),
    tokenNumber,
    totalFee: transaction.totalFee,
    tender: transaction.tender,
    receiptNumber: transaction.receiptNumber,
    collectedBy: String(transaction.collectedBy),
  });
};
