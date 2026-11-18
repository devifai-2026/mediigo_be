import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { appError } from './errors.js';
import { RESPONSE_CODES } from '../config/constants.js';

/**
 * Reversible encryption for third-party credentials kept in the database.
 *
 * Not a hash, on purpose: a hash cannot be turned back into the key, and the
 * server has to send the real Cashfree secret on every API call. AES-256-GCM
 * means a stolen database dump is useless without PAYMENT_KEYS_SECRET, and the
 * auth tag means a tampered ciphertext fails to decrypt instead of decrypting
 * to garbage.
 *
 * Stored form: "v1:<iv b64>:<tag b64>:<ciphertext b64>". The version prefix
 * leaves room to change the scheme without guessing what an old value is.
 */
const keyFrom = () => {
  if (!env.PAYMENT_KEYS_SECRET) {
    throw appError({
      status: 503,
      code: RESPONSE_CODES.PAYMENTS_NOT_CONFIGURED,
      message: 'PAYMENT_KEYS_SECRET is not set on the server, so payment keys cannot be stored or read',
    });
  }
  // Derived, so any 32+ character secret yields exactly a 256-bit key.
  return crypto.createHash('sha256').update(env.PAYMENT_KEYS_SECRET).digest();
};

export const canEncrypt = () => Boolean(env.PAYMENT_KEYS_SECRET);

export const encryptSecret = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
};

/** Null when there is nothing stored or it cannot be decrypted (e.g. the master key changed). */
export const decryptSecret = (stored) => {
  if (!stored) return null;
  const [v, iv, tag, data] = String(stored).split(':');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err?.isAppError) throw err;
    return null;
  }
};

/** "…a1b2" — enough for an admin to recognise which key is saved, nothing more. */
export const hintOf = (plain) => (plain ? `…${String(plain).slice(-4)}` : '');
