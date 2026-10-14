import { OPDToken } from '../models/OPDToken.js';
import { Doctor } from '../models/Doctor.js';
import { Transaction } from '../models/Transaction.js';
import { TOKEN_STATUS, TOKEN_SOURCE, VISIT_TYPE } from '../config/constants.js';
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
    Doctor.findById(doctorId).select('name specialty chamberNumber avgConsultMinutes session hospitalId').lean(),
    // A cancelled token, or one waiting for its patient to pick a new slot,
    // is not in today's queue: counting it inflated "Total Registered" and put
    // a patient who will not come on the roster and the waiting-room board.
    OPDToken.find({ doctorId, date, status: { $nin: [TOKEN_STATUS.CANCELLED, TOKEN_STATUS.RESCHEDULE_NEEDED] } })
      .select('tokenNumber status source patientSnapshot patientId calledAt enteredChamberAt completedAt skipReason visitType shift startTime endTime outcome followUp.status followUp.respondBy followUpTokenId')
      .sort({ tokenNumber: 1 })
      .lean(),
  ]);
  if (!doctor) return null;

  // Today's cancellations, for clinic staff only: who took a patient off the
  // list and why. A waiting-room board never sees these.
  // Fetched for every snapshot, because they still count towards `version`;
  // their details are only sent to staff.
  const cancelledQuery = OPDToken.find({ doctorId, date, status: TOKEN_STATUS.CANCELLED })
    .select('tokenNumber patientSnapshot.name cancelReason cancelledAt cancelledBy cancelledByRole doctorAlert isPaid visitType')
    .sort({ cancelledAt: -1 });
  if (includePii) cancelledQuery.populate('cancelledBy', 'name');
  const cancellations = await cancelledQuery.lean();

  // What each patient paid, for the desk's roster. Staff only, and fetched
  // only then: a public display has no business knowing anyone's fee.
  const paidByToken = new Map();
  if (includePii && tokens.length) {
    const txns = await Transaction.find({ tokenId: { $in: tokens.map((t) => t._id) }, status: 'PAID' })
      .select('tokenId totalFee tender')
      .lean();
    for (const x of txns) paidByToken.set(String(x.tokenId), x);
  }

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
    specialty: doctor.specialty || '',
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
      // Online = the patient booked it themselves (app or QR standee);
      // otherwise the desk booked it. Either way they are seen in the clinic.
      bookedOnline: t.source === TOKEN_SOURCE.APP || t.source === TOKEN_SOURCE.QR_SCAN,
      // Public displays get a masked name; staff clients get the real one.
      name: includePii ? t.patientSnapshot?.name ?? '' : maskName(t.patientSnapshot?.name),
      // Age and gender are clinical context, not identity — a waiting-room
      // board showing "34 F" next to a masked name is still anonymous.
      age: t.patientSnapshot?.age ?? null,
      gender: t.patientSnapshot?.gender ?? null,
      // Clinical context the doctor needs before calling someone in. Staff
      // only: a waiting-room board must never publish a patient's history.
      conditions: includePii ? (t.patientSnapshot?.conditions ?? []) : [],
      // Staff only: the reason for the visit is clinical detail and has no
      // business on a public waiting-room display.
      ...(includePii
        ? {
          patientId: String(t.patientId),
          phone: t.patientSnapshot?.phone,
          complaint: t.patientSnapshot?.complaint ?? '',
          ...paymentOf(paidByToken.get(String(t._id))),
        }
        : {}),
      // When the patient walked into the chamber, so the desk can see how long
      // the current consultation has been running.
      enteredChamberAt: t.enteredChamberAt ?? t.calledAt ?? null,
      completedAt: t.completedAt ?? null,
      outcome: t.outcome ?? null,
      skipReason: t.skipReason ?? null,
      // A doctor-booked follow-up and whether the patient has said they will
      // come. Unconfirmed ones are the slots the roster lets staff release.
      followUpStatus: t.followUp?.status ?? null,
      followUpRespondBy: t.followUp?.respondBy ?? null,
      // On a consultation: it already has a follow-up booked.
      hasFollowUp: Boolean(t.followUpTokenId),
    })),
    // Monotonic within a doctor-day: the number of state transitions so far.
    cancellations: (includePii ? cancellations : []).map((c) => ({
      tokenId: String(c._id),
      tokenNumber: c.tokenNumber,
      name: c.patientSnapshot?.name ?? '',
      reason: c.cancelReason || '',
      byRole: c.cancelledByRole || 'PATIENT',
      byName: c.cancelledBy?.name ?? '',
      at: c.cancelledAt,
      wasPaid: Boolean(c.isPaid),
      visitType: c.visitType ?? 'fresh',
      needsAck: Boolean(c.doctorAlert?.pending),
      acknowledgedAt: c.doctorAlert?.acknowledgedAt ?? null,
    })),
    // Cancelled tokens are off the list but still count, or cancelling a
    // waiting token would LOWER the version and every client would discard
    // the update as stale. waiting (1) → cancelled (2) → acknowledged (3).
    version: tokens.reduce((acc, t) => acc + 1 + (t.status === TOKEN_STATUS.WAITING ? 0 : 1), 0)
      + cancellations.reduce((acc, c) => acc + 2 + (c.doctorAlert?.acknowledgedAt ? 1 : 0), 0),
    updatedAt: new Date().toISOString(),
  };
};

/**
 * Fee and how it was paid, for one token. A token booked in the app may not
 * have been paid at the desk yet, which the roster shows as unpaid rather than
 * as a zero fee.
 */
const paymentOf = (txn) => {
  if (!txn) return { fee: null, paymentMode: null };
  const used = ['cash', 'upi', 'card'].filter((k) => (txn.tender?.[k] ?? 0) > 0);
  return {
    fee: txn.totalFee,
    paymentMode: used.length > 1 ? 'SPLIT' : (used[0]?.toUpperCase() ?? 'FREE'),
  };
};
