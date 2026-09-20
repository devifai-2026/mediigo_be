// Functional error factories. Every thrown error carries an HTTP status and a
// stable machine-readable code, so the error middleware never has to guess.
import { RESPONSE_CODES } from '../config/constants.js';

export const appError = ({ status = 500, code = RESPONSE_CODES.INTERNAL, message, details, cause }) => {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  if (details !== undefined) err.details = details;
  if (cause !== undefined) err.cause = cause;
  err.isAppError = true;
  return err;
};

export const validationError = (issues, code = RESPONSE_CODES.VALIDATION, details) =>
  appError({
    status: 422,
    code,
    message: Array.isArray(issues) && issues[0]?.message ? issues[0].message : 'Validation failed',
    details: { issues: Array.isArray(issues) ? issues : [], ...(details || {}) },
  });

export const unauthenticated = (message = 'Authentication required') =>
  appError({ status: 401, code: RESPONSE_CODES.UNAUTHENTICATED, message });

export const forbidden = (message = 'You do not have access to this resource', code = RESPONSE_CODES.FORBIDDEN, details) =>
  appError({ status: 403, code, message, details });

export const notFound = (message = 'Not found') =>
  appError({ status: 404, code: RESPONSE_CODES.NOT_FOUND, message });

export const conflict = (message, code = RESPONSE_CODES.CONFLICT, details) =>
  appError({ status: 409, code, message, details });

export const gone = (message, details) =>
  appError({ status: 410, code: RESPONSE_CODES.GONE, message, details });

export const tooManyRequests = (message = 'Too many requests') =>
  appError({ status: 429, code: RESPONSE_CODES.RATE_LIMITED, message });

// Mongo signals a duplicate key in several shapes depending on whether the write
// happened inside a transaction, in a bulk op, or standalone. Check all of them.
export const isDuplicateKey = (err) =>
  err?.code === 11000 ||
  err?.codeName === 'DuplicateKey' ||
  (Array.isArray(err?.writeErrors) && err.writeErrors.some((e) => e?.code === 11000 || e?.err?.code === 11000));

// withTransaction retries these itself — if one reaches our catch block it has
// already exhausted its internal retries.
export const isTransient = (err) => Boolean(err?.errorLabels?.includes('TransientTransactionError'));
