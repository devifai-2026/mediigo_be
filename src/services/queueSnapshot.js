import { OPDToken } from '../models/OPDToken.js';
import { Doctor } from '../models/Doctor.js';
import { TOKEN_STATUS } from '../config/constants.js';
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
      .select('tokenNumber status patientSnapshot patientId calledAt completedAt skipReason')
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

  return {
    doctorId: String(doctorId),
    doctorName: doctor.name,
    hospitalId: String(doctor.hospitalId),
    chamberNumber: doctor.chamberNumber || '',
    date,
    currentToken: inChamber?.tokenNumber ?? doctor.session?.lastCalledToken ?? 0,
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
      // Public displays get a masked name; staff clients get the real one.
      name: includePii ? t.patientSnapshot?.name ?? '' : maskName(t.patientSnapshot?.name),
      ...(includePii ? { patientId: String(t.patientId), phone: t.patientSnapshot?.phone } : {}),
      skipReason: t.skipReason ?? null,
    })),
    // Monotonic within a doctor-day: the number of state transitions so far.
    version: tokens.reduce((acc, t) => acc + 1 + (t.status === TOKEN_STATUS.WAITING ? 0 : 1), 0),
    updatedAt: new Date().toISOString(),
  };
};
