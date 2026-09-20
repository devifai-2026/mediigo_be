import { logger } from '../lib/logger.js';
import { RESPONSE_CODES } from '../config/constants.js';
import { isProduction } from '../config/env.js';
import { isDuplicateKey, notFound } from '../lib/errors.js';

export const notFoundHandler = (req, _res, next) => {
  next(notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};

// Translates Mongo/Mongoose failures into the same envelope as our own errors,
// so a client never has to parse two different error shapes.
const mapKnownErrors = (err) => {
  if (err?.isAppError) return err;

  if (err?.name === 'ValidationError' && err?.errors) {
    const issues = Object.entries(err.errors).map(([path, e]) => ({ path, message: e.message }));
    return { status: 422, code: RESPONSE_CODES.VALIDATION, message: issues[0]?.message || 'Validation failed', details: { issues } };
  }
  if (err?.name === 'CastError') {
    return { status: 400, code: RESPONSE_CODES.VALIDATION, message: `Invalid ${err.path}`, details: { path: err.path } };
  }
  if (isDuplicateKey(err)) {
    const fields = Object.keys(err.keyPattern || err.keyValue || {});
    return {
      status: 409,
      code: RESPONSE_CODES.CONFLICT,
      message: `A record with this ${fields.join(', ') || 'value'} already exists`,
      details: { fields },
    };
  }
  return null;
};

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
export const errorHandler = (err, req, res, _next) => {
  const mapped = mapKnownErrors(err) || {
    status: err?.status || 500,
    code: err?.code || RESPONSE_CODES.INTERNAL,
    message: err?.message || 'Something went wrong',
    details: err?.details,
  };

  const log = mapped.status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
  log(
    { err, reqId: req.id, method: req.method, url: req.originalUrl, status: mapped.status, code: mapped.code },
    'request failed',
  );

  res.status(mapped.status).json({
    ok: false,
    error: {
      code: mapped.code,
      // Never leak an internal exception message to a client in production.
      message: mapped.status >= 500 && isProduction() ? 'Something went wrong' : mapped.message,
      ...(mapped.details ? { details: mapped.details } : {}),
      requestId: req.id,
    },
  });
};
