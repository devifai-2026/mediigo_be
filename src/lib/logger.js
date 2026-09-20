import pino from 'pino';
import { env, isProduction } from '../config/env.js';

// aadhaarNumber and the WABridge keys must never reach a log sink. Redaction is
// configured here rather than at call sites so a new log line can't leak one.
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'aadhaarNumber',
      'body.aadhaarNumber',
      'req.body.aadhaarNumber',
      'password',
      'body.password',
      'req.body.password',
      'passwordHash',
      'otp',
      'body.otp',
      'req.body.otp',
      'otpHash',
      'authKey',
      'auth-key',
      'appKey',
      'app-key',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  transport: isProduction()
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});

// Phone numbers in logs: keep enough to correlate, not enough to identify.
export const maskPhone = (phone) => {
  const s = String(phone ?? '');
  if (s.length < 4) return '****';
  return `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
};

// Patient names on public displays: "Rajesh Kumar" -> "RAJ***"
export const maskName = (name) => {
  const s = String(name ?? '').trim();
  if (!s) return '***';
  return `${s.slice(0, 3).toUpperCase()}***`;
};
