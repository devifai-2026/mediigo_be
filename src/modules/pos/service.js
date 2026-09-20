import mongoose from 'mongoose';
import { User, Hospital, Doctor, OPDToken, Transaction } from '../../models/index.js';
import { nextSequence, tokenCounterId, receiptCounterId, formatReceipt } from '../../lib/counters.js';
import { paise, tenderTotalPaise } from '../../lib/money.js';
import { clinicDate, financialYear, endOfClinicDay, jitterDelay, sleep } from '../../lib/dates.js';
import { last10Digits } from '../../lib/phone.js';
import { conflict, validationError, notFound, isDuplicateKey } from '../../lib/errors.js';
import { assertHospitalScope } from '../../middleware/rbac.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import {
  ROLES, NETWORK_STATE, TOKEN_STATUS, TOKEN_SOURCE, VISIT_TYPE,
  RESPONSE_CODES, AUDIT_ACTIONS,
} from '../../config/constants.js';
import { emitQueueSnapshot, emitTokenCreated, emitTransactionRecorded } from '../../realtime/emitters.js';

const MAX_ALLOC_RETRIES = 5;

/** Cheap validation outside the session — fail fast before opening a transaction. */
const preflight = async (body, actor) => {
  const doctor = await Doctor.findById(body.doctorId).lean();
  if (!doctor || !doctor.isActive) throw notFound('Doctor not found');

  const hospital = await Hospital.findById(doctor.hospitalId).lean();
  if (!hospital) throw notFound('Hospital not found');

  assertHospitalScope(actor, hospital);

  if (hospital.networkState !== NETWORK_STATE.ACTIVE) {
    throw conflict(
      `This clinic is ${hospital.networkState.toLowerCase().replace('_', ' ')} and cannot take new bookings`,
      RESPONSE_CODES.HOSPITAL_NOT_ACTIVE,
    );
  }
  if (!doctor.session?.isBookingOpen) {
    throw conflict('Bookings are closed for this doctor', RESPONSE_CODES.BOOKING_CLOSED);
  }
  return { doctor, hospital };
};

const resolvePatient = async (body, session) => {
  if (body.patientId) {
    const existing = await User.findById(body.patientId).session(session);
    if (existing) return existing;
  }
  const phone = last10Digits(body.patient?.phone);
  if (phone) {
    const byPhone = await User.findOne({ phone }).session(session);
    if (byPhone) return byPhone;
  }
  const [created] = await User.create(
    [{
      phone: phone || `NOPHONE-${Date.now()}`,
      name: body.patient?.name || 'Walk-in Patient',
      role: ROLES.PATIENT,
      gender: body.patient?.gender,
    }],
    { session },
  );
  return created;
};

/**
 * Transactional walk-in registration.
 *
 * Concurrency design — two mechanisms, deliberately both:
 *
 *  1. A Counter document incremented inside the transaction. That takes a
 *     document-level write lock for the txn's duration, so concurrent walk-ins
 *     for the same doctor SERIALIZE on it instead of racing. Mongo reports the
 *     contention as a WriteConflict, which IS a TransientTransactionError, and
 *     session.withTransaction() retries those automatically. That auto-retry is
 *     what makes the common path correct without any code from us.
 *
 *  2. The {doctorId, date, tokenNumber} compound unique index as a correctness
 *     backstop, wrapped in the bounded retry loop below. The subtlety: an E11000
 *     raised inside a transaction ABORTS THE WHOLE TRANSACTION and is NOT retried
 *     by withTransaction — so the loop must re-run the entire callback, not just
 *     the failed insert.
 */
export const createWalkin = async ({ body, actor, ip, userAgent }) => {
  const { doctor, hospital } = await preflight(body, actor);
  const date = clinicDate(hospital.timezone);
  const fy = financialYear(date);
  const visitType = body.visitType || VISIT_TYPE.FRESH;
  const discount = Number(body.discount || 0);

  // Reject a duplicate submission before doing any work. The unique partial
  // index on idempotencyKey is the real guarantee; this is just a fast path.
  if (body.idempotencyKey) {
    const dupe = await Transaction.findOne({ idempotencyKey: body.idempotencyKey }).lean();
    if (dupe) {
      const tok = await OPDToken.findById(dupe.tokenId).lean();
      return { token: tok, transaction: dupe, idempotentReplay: true };
    }
  }

  let lastErr;
  for (let attempt = 0; attempt < MAX_ALLOC_RETRIES; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let result;
      // eslint-disable-next-line no-await-in-loop
      await session.withTransaction(
        async () => {
          // (1) Re-read the doctor INSIDE the session: fees or the booking flag
          // could have changed between preflight and here.
          const live = await Doctor.findById(doctor._id).session(session).lean();
          if (!live?.session?.isBookingOpen) {
            throw conflict('Bookings are closed for this doctor', RESPONSE_CODES.BOOKING_CLOSED);
          }

          const baseFee = live.fees[visitType];
          if (baseFee == null) throw validationError([{ path: 'visitType', message: 'Unknown visit type' }]);
          if (discount > baseFee) {
            throw validationError([{ path: 'discount', message: 'Discount cannot exceed the consultation fee' }]);
          }
          const totalFee = baseFee - discount;

          // (2) The split-POS invariant, asserted in integer paise against the
          // LIVE fee. Comparing rupee floats is how a ₹0.01 drift silently
          // passes a tender that should fail.
          const tender = {
            cash: Number(body.tender?.cash || 0),
            upi: Number(body.tender?.upi || 0),
            card: Number(body.tender?.card || 0),
          };
          const tendered = tenderTotalPaise(tender);
          if (tendered !== paise(totalFee)) {
            throw validationError(
              [{ path: 'tender', message: 'Cash + UPI + Card must exactly equal the total fee' }],
              RESPONSE_CODES.TENDER_MISMATCH,
              { totalFee, tendered: tendered / 100, difference: (paise(totalFee) - tendered) / 100 },
            );
          }

          const patient = await resolvePatient(body, session);

          // (3) Allocate the token number. A WriteConflict here is transient and
          // retried by withTransaction itself.
          const tokenNumber = await nextSequence(tokenCounterId(live._id, date), session, {
            expiresAt: endOfClinicDay(date, hospital.timezone),
          });

          // (4) Receipt sequence: per hospital, per financial year.
          const receiptSeq = await nextSequence(receiptCounterId(hospital._id, fy), session);
          const receiptNumber = formatReceipt(env.RECEIPT_PREFIX, hospital.code, fy, receiptSeq);

          // (5) Insert the token. E11000 here aborts the txn; the outer loop retries.
          const [token] = await OPDToken.create(
            [{
              tokenNumber,
              date,
              doctorId: live._id,
              hospitalId: hospital._id,
              patientId: patient._id,
              familyMemberId: body.familyMemberId ?? null,
              patientSnapshot: {
                name: body.patient?.name || patient.name,
                phone: patient.phone,
                age: body.patient?.age,
                gender: body.patient?.gender || patient.gender,
                complaint: body.patient?.complaint,
              },
              visitType,
              source: TOKEN_SOURCE.WALKIN,
              status: TOKEN_STATUS.WAITING,
              statusHistory: [{ from: null, to: TOKEN_STATUS.WAITING, at: new Date(), byUserId: actor.id }],
              isPaid: true,
              bookedBy: actor.id,
            }],
            { session, ordered: true },
          );

          const [txn] = await Transaction.create(
            [{
              tokenId: token._id,
              hospitalId: hospital._id,
              doctorId: live._id,
              patientId: patient._id,
              date,
              visitType,
              baseFee,
              discount,
              totalFee,
              tender,
              upiRef: body.upiRef,
              cardLast4: body.cardLast4,
              receiptNumber,
              receiptSeq,
              fy,
              collectedBy: actor.id,
              idempotencyKey: body.idempotencyKey ?? null,
            }],
            { session, ordered: true },
          );

          await OPDToken.updateOne({ _id: token._id }, { $set: { transactionId: txn._id } }, { session });

          result = { token: { ...token.toObject(), transactionId: txn._id }, transaction: txn.toObject() };
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
          maxCommitTimeMS: 10_000,
        },
      );

      // ---- post-commit side effects. Never inside the transaction. ----
      emitTokenCreated(result.token);
      emitTransactionRecorded({ transaction: result.transaction, tokenNumber: result.token.tokenNumber });
      emitQueueSnapshot(result.token.doctorId, date).catch(() => {});
      writeAuditLog({
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.WALKIN_BOOKED,
        entityType: 'OPDToken',
        entityId: result.token._id,
        hospitalId: hospital._id,
        districtId: hospital.districtId,
        ip,
        userAgent,
        after: {
          tokenNumber: result.token.tokenNumber,
          totalFee: result.transaction.totalFee,
          receiptNumber: result.transaction.receiptNumber,
        },
      });

      return result;
    } catch (err) {
      lastErr = err;
      if (isDuplicateKey(err) && attempt < MAX_ALLOC_RETRIES - 1) {
        logger.warn({ attempt, doctorId: String(doctor._id) }, 'token allocation collided, retrying');
        // eslint-disable-next-line no-await-in-loop
        await sleep(jitterDelay(attempt));
        continue;
      }
      throw err;
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await session.endSession();
    }
  }

  throw conflict(
    'Could not allocate a token number, please retry',
    RESPONSE_CODES.TOKEN_ALLOC_EXHAUSTED,
    { cause: lastErr?.message },
  );
};

/** Pay for an already-booked (app) token. Same tender invariant. */
export const payForToken = async ({ tokenId, body, actor, ip, userAgent }) => {
  const token = await OPDToken.findById(tokenId);
  if (!token) throw notFound('Token not found');
  if (token.isPaid) throw conflict('This token has already been paid');

  const [hospital, doctor] = await Promise.all([
    Hospital.findById(token.hospitalId).lean(),
    Doctor.findById(token.doctorId).lean(),
  ]);
  assertHospitalScope(actor, hospital);

  const fy = financialYear(token.date);
  const baseFee = doctor.fees[token.visitType];
  const discount = Number(body.discount || 0);
  const totalFee = baseFee - discount;

  const tender = {
    cash: Number(body.tender?.cash || 0),
    upi: Number(body.tender?.upi || 0),
    card: Number(body.tender?.card || 0),
  };
  if (tenderTotalPaise(tender) !== paise(totalFee)) {
    throw validationError(
      [{ path: 'tender', message: 'Cash + UPI + Card must exactly equal the total fee' }],
      RESPONSE_CODES.TENDER_MISMATCH,
      { totalFee, tendered: tenderTotalPaise(tender) / 100 },
    );
  }

  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      const receiptSeq = await nextSequence(receiptCounterId(hospital._id, fy), session);
      const [txn] = await Transaction.create(
        [{
          tokenId: token._id, hospitalId: hospital._id, doctorId: token.doctorId, patientId: token.patientId,
          date: token.date, visitType: token.visitType, baseFee, discount, totalFee, tender,
          upiRef: body.upiRef, cardLast4: body.cardLast4,
          receiptNumber: formatReceipt(env.RECEIPT_PREFIX, hospital.code, fy, receiptSeq),
          receiptSeq, fy, collectedBy: actor.id, idempotencyKey: body.idempotencyKey ?? null,
        }],
        { session, ordered: true },
      );
      await OPDToken.updateOne({ _id: token._id }, { $set: { isPaid: true, transactionId: txn._id } }, { session });
      out = txn.toObject();
    });

    emitTransactionRecorded({ transaction: out, tokenNumber: token.tokenNumber });
    writeAuditLog({
      actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.TOKEN_PAID,
      entityType: 'Transaction', entityId: out._id, hospitalId: hospital._id, ip, userAgent,
      after: { receiptNumber: out.receiptNumber, totalFee },
    });
    return out;
  } finally {
    await session.endSession();
  }
};

/**
 * Day close. Revenue counts COMPLETED consultations only, and there is no petty
 * cash anywhere — reconciliation is gross expected vs actual deposits.
 */
export const dayClose = async ({ hospitalId, date, actor }) => {
  const hospital = await Hospital.findById(hospitalId).lean();
  assertHospitalScope(actor, hospital);
  const day = date || clinicDate(hospital.timezone);

  const rows = await Transaction.aggregate([
    { $match: { hospitalId: hospital._id, date: day, status: 'PAID' } },
    { $lookup: { from: 'opdtokens', localField: 'tokenId', foreignField: '_id', as: 'token' } },
    { $unwind: '$token' },
    // Only completed consultations count as earned revenue. Billing a patient
    // who was skipped or is still waiting overstates the day.
    { $match: { 'token.status': TOKEN_STATUS.COMPLETED } },
    {
      $group: {
        _id: '$collectedBy',
        cash: { $sum: '$tender.cash' },
        upi: { $sum: '$tender.upi' },
        card: { $sum: '$tender.card' },
        total: { $sum: '$totalFee' },
        count: { $sum: 1 },
      },
    },
  ]);

  const collectors = await User.find({ _id: { $in: rows.map((r) => r._id) } }).select('name').lean();
  const nameOf = new Map(collectors.map((c) => [String(c._id), c.name]));

  const totals = rows.reduce(
    (acc, r) => ({
      cash: acc.cash + r.cash, upi: acc.upi + r.upi, card: acc.card + r.card,
      total: acc.total + r.total, count: acc.count + r.count,
    }),
    { cash: 0, upi: 0, card: 0, total: 0, count: 0 },
  );

  // Everything billed today, including not-yet-completed, shown separately so
  // the desk can see what is still outstanding without it inflating revenue.
  const billedAll = await Transaction.aggregate([
    { $match: { hospitalId: hospital._id, date: day, status: 'PAID' } },
    { $group: { _id: null, total: { $sum: '$totalFee' }, count: { $sum: 1 } } },
  ]);

  return {
    hospitalId: String(hospital._id),
    hospitalName: hospital.name,
    date: day,
    basis: 'COMPLETED_ONLY',
    expected: totals,
    byCollector: rows.map((r) => ({
      collectorId: String(r._id), collectorName: nameOf.get(String(r._id)) || 'Unknown',
      cash: r.cash, upi: r.upi, card: r.card, total: r.total, count: r.count,
    })),
    billedIncludingIncomplete: { total: billedAll[0]?.total ?? 0, count: billedAll[0]?.count ?? 0 },
  };
};
