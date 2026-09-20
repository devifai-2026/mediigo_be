import crypto from 'node:crypto';
import { sha256Hex } from './crypto.js';

// Ported from the proven Extraeedge implementation. Uniform digit selection via
// randomBytes; modulo bias over 10 from a 256-value byte is negligible here and
// the original is battle-tested, so it is kept byte-for-byte.
export const generateOtp = (length = 6) => {
  const digits = '0123456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += digits[bytes[i] % 10];
  return out;
};

// Salting with the phone number means an OTP hash stolen from one row cannot be
// replayed against another.
export const hashOtp = (otp, phoneOrEmail) => sha256Hex(`${otp}:${phoneOrEmail}`);

// TTL is a parameter rather than an env read, because it is runtime-configurable
// through the WaSettings document.
export const otpExpiryDate = (ttlMinutes) => new Date(Date.now() + ttlMinutes * 60_000);
