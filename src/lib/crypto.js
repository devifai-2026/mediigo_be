import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const sha256Hex = (input) => crypto.createHash('sha256').update(String(input)).digest('hex');

export const hmacHex = (key, input) => crypto.createHmac('sha256', key).update(String(input)).digest('hex');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const randomUUID = () => crypto.randomUUID();

// Aadhaar is hashed with an HMAC, never a bare sha256. There are only 10^12
// possible Aadhaar numbers — a plain digest is brute-forceable in GPU-hours,
// which would turn the policy vault into a liability. The pepper is what makes
// the hash useless to anyone who steals only the database.
//
// Rotating AADHAAR_HASH_PEPPER invalidates every stored hash. Don't, without a
// migration that re-hashes from source (which you cannot do — we never store
// the raw number).
export const aadhaarHash = (aadhaarNumber) => {
  const digits = String(aadhaarNumber ?? '').replace(/\D/g, '');
  if (digits.length !== 12) return null;
  return hmacHex(env.AADHAAR_HASH_PEPPER, digits);
};

// Verhoeff checksum — the algorithm UIDAI actually uses for Aadhaar. Catches
// single-digit typos and most transpositions before we bother hashing.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export const isValidAadhaar = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 12) return false;
  if (digits[0] === '0' || digits[0] === '1') return false; // UIDAI never issues these
  let c = 0;
  const reversed = digits.split('').reverse().map(Number);
  for (let i = 0; i < reversed.length; i += 1) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversed[i]]];
  return c === 0;
};

// Signed credential for waiting-room displays: they cannot hold an expiring
// session, so a standee proves identity instead.
export const signStandeeToken = (serialId, secret) => `${serialId}:${hmacHex(secret, serialId)}`;

export const verifyStandeeToken = (token, secret) => {
  const [serialId, sig] = String(token ?? '').split(':');
  if (!serialId || !sig) return null;
  const expected = hmacHex(secret, serialId);
  // Constant-time compare — a length mismatch would throw, so guard it first.
  if (sig.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? serialId : null;
};
