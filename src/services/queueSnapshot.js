import { OPDToken } from '../models/OPDToken.js';
import { Doctor } from '../models/Doctor.js';
import { TOKEN_STATUS, VISIT_TYPE } from '../config/constants.js';
import { maskName } from '../lib/logger.js';

/**
 * Authoritative queue state for one doctor on one day.
 *
 * Every mutation emits this whole object rather than a delta. Queue state is
 * tiny (<100 tokens), and a delta lost to a waiting-room wifi blip would leave a
 * wrong number on a public display — the worst failure this product has.
 *
 * `version` lets clients detect a missed update: a snapshot whose version is not
 * exactly one more than the last one means a gap, so the client refetches.
 */
export const buildQueueSnapshot = async (doctorId, date, { includePii = false } = {}) => {
  const [doctor, tokens] = await Promise.all([
    Doctor.findById(doctorId).select('name chamberNumber avgConsultMinutes session hospitalId').lean(),
    OPDToken.find({ doctorId, date })
      .select('tokenNumber status patientSnapshot patientId calledAt completedAt skipReason visitType shift startTime endTime')
      .sort({ tokenNumber: 1 })
      .lean(),
  ]);
  if (!doctor) return null;

  const byStatus = (s) => tokens.filter((t) => t.status === s);
  const waiting = byStatus(TOKEN_STATUS.WAITING);
  const inChamber = byStatus(TOKEN_STATUS.IN_CHAMBER)[0] || null;
  const completed = byStatus(TOKEN_STATUS.COMPLETED);
  const skipped = byStatus(TOKEN_STATUS.SKIPPED);

  const onBreak = Boolean(doctor.session?.isOnBreak);
  const avg = doctor.avgConsultMinutes || 8;

  // tokens is already scoped to `date`, so a match here proves the stored
  // lastCalledToken belongs to this day's session rather than an earlier one.
  const lastCalled = doctor.session?.lastCalledToken ?? null;
  const lastCalledToday = lastCalled && tokens.some((t) => t.tokenNumber === lastCalled) ? lastCalled : null;

  return {
    doctorId: String(doctorId),
    doctorName: doctor.name,
    hospitalId: String(doctor.hospitalId),
    chamberNumber: doctor.chamberNumber || '',
    date,
    // Falling back to lastCalledToken keeps the board reading "#03" after that
    // patient is marked complete, instead of snapping back to "#00". But that
    // field lives on the doctor and carries no date, so yesterday's last call
    // would otherwise show above today's empty queue. Only trust it when it
    // names a token from the day being rendered.
    currentToken: inChamber?.tokenNumber ?? lastCalledToday ?? 0,
    // Explicit, so no client has to infer "is that number live or finished?"
    // from the absence of an IN_CHAMBER row and get it wrong on a public board.
    //   IN_CHAMBER — currentToken is with the doctor right now
    //   DONE       — that consultation is finished
    //   IDLE       — nobody has been called into the chamber today
    chamberState: inChamber ? 'IN_CHAMBER' : lastCalledToday ? 'DONE' : 'IDLE',
    session: {
      isBookingOpen: Boolean(doctor.session?.isBookingOpen),
      isOnBreak: onBreak,
      breakReason: doctor.session?.breakReason ?? null,
      breakUntil: doctor.session?.breakUntil ?? null,
    },
    counts: {
      waiting: waiting.length,
      completed: completed.length,
      skipped: skipped.length,
      total: tokens.length,
    },
    avgConsultMinutes: avg,
    // While a doctor is on break the queue is not advancing, so any ETA we
    // published would be a lie. Send null and let the UI say "Paused".
    estimatedWaitMinutes: onBreak ? null : waiting.length * avg,
    tokens: tokens.map((t) => ({
      tokenId: String(t._id),
      tokenNumber: t.tokenNumber,
      status: t.status,
      // Drives the emergency flag in the roster: the front desk and the doctor
      // both need to see an emergency without opening the row.
      visitType: t.visitType ?? 'fresh',
      isEmergency: t.visitType === VISIT_TYPE.EMERGENCY,
      // Public displays get a masked name; staff clients get the real one.
      name: includePii ? t.patientSnapshot?.name ?? '' : maskName(t.patientSnapshot?.name),
      // Age and gender are clinical context, not identity — a waiting-room
      // board showing "34 F" next to a masked name is still anonymous.
      age: t.patientSnapshot?.age ?? null,
      gender: t.patientSnapshot?.gender ?? null,
      // Staff only: the reason for the visit is clinical detail and has no
      // business on a public waiting-room display.
      ...(includePii
        ? { patientId: String(t.patientId), phone: t.patientSnapshot?.phone, complaint: t.patientSnapshot?.complaint ?? '' }
        : {}),
      skipReason: t.skipReason ?? null,
    })),
    // Monotonic within a doctor-day: the number of state transitions so far.
    version: tokens.reduce((acc, t) => acc + 1 + (t.status === TOKEN_STATUS.WAITING ? 0 : 1), 0),
    updatedAt: new Date().toISOString(),
  };
};
