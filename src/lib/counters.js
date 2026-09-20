import { Counter } from '../models/Counter.js';

// Atomic sequence allocation.
//
// Called INSIDE a transaction this takes a document-level write lock on the
// counter for the transaction's duration, so concurrent walk-ins for the same
// doctor serialize on it rather than racing to the same token number. Mongo
// surfaces that contention as a WriteConflict, which IS a TransientTransactionError
// — and session.withTransaction() retries those automatically. That auto-retry is
// the property the whole POS concurrency design rests on.
//
// The upsert makes the first allocation of the day work with no seeding. Two
// concurrent upserts on a not-yet-existing _id can throw E11000 on the _id index;
// that is caught by the caller's retry loop and never recurs once the doc exists.
export const nextSequence = async (id, session, { expiresAt } = {}) => {
  const doc = await Counter.findOneAndUpdate(
    { _id: id },
    { $inc: { seq: 1 }, ...(expiresAt ? { $setOnInsert: { expiresAt } } : {}) },
    { new: true, upsert: true, session },
  );
  return doc.seq;
};

export const tokenCounterId = (doctorId, date) => `token:${doctorId}:${date}`;
export const receiptCounterId = (hospitalId, fy) => `receipt:${hospitalId}:${fy}`;

export const formatReceipt = (prefix, hospitalCode, fy, seq) =>
  `${prefix}/${hospitalCode}/${fy}/${String(seq).padStart(5, '0')}`;
