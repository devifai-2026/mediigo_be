import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { RESPONSE_CODES } from '../config/constants.js';
import { last10Digits } from '../lib/phone.js';

const handler = (req, res) => {
  res.status(429).json({
    ok: false,
    error: { code: RESPONSE_CODES.RATE_LIMITED, message: 'Too many requests, please slow down', requestId: req.id },
  });
};

export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Keyed by phone, not IP: a whole clinic behind one NAT would otherwise lock
// each other out, while an attacker rotating IPs against one number would not
// be limited at all.
export const otpLimiter = rateLimit({
  windowMs: env.OTP_RATE_LIMIT_WINDOW_MS,
  max: env.OTP_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => last10Digits(req.body?.phone) || req.ip,
  handler,
});
