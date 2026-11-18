import crypto from 'node:crypto';
import { appError } from '../errors.js';
import { logger } from '../logger.js';
import { RESPONSE_CODES } from '../../config/constants.js';

/**
 * Cashfree Payment Gateway, PG API v2025-01-01. Plain fetch, no SDK: four calls
 * do not justify a dependency, and the SDK's global configuration does not fit
 * holding sandbox and production credentials at once.
 *
 * Docs: https://www.cashfree.com/docs/api-reference/payments/previous/v2025-01-01/overview
 */
const API_VERSION = '2025-01-01';
const BASE = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
};
const TIMEOUT_MS = 10_000;

const call = async ({ creds, method = 'GET', path, body, idempotencyKey }) => {
  const url = `${BASE[creds.mode]}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-version': API_VERSION,
        'x-client-id': creds.appId,
        'x-client-secret': creds.secretKey,
        ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logger.error({ err: err.message, path }, 'cashfree: request failed');
    throw appError({
      status: 502, code: RESPONSE_CODES.PAYMENT_GATEWAY_ERROR,
      message: 'Could not reach the payment gateway. Please try again.',
    });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) {
    logger.warn({ status: res.status, path, code: data?.code, message: data?.message }, 'cashfree: error response');
    const err = appError({
      status: 502, code: RESPONSE_CODES.PAYMENT_GATEWAY_ERROR,
      message: data?.message || `Payment gateway error (${res.status})`,
    });
    err.gatewayStatus = res.status;
    throw err;
  }
  return data;
};

/** https://www.cashfree.com/docs/api-reference/payments/previous/v2025-01-01/orders/create */
export const createOrder = ({ creds, order }) =>
  call({ creds, method: 'POST', path: '/orders', body: order, idempotencyKey: order.order_id });

/** order_status: ACTIVE | PAID | EXPIRED | TERMINATED | TERMINATION_REQUESTED */
export const getOrder = ({ creds, orderId }) =>
  call({ creds, path: `/orders/${encodeURIComponent(orderId)}` });

/** The payments attempted on an order; the successful one carries cf_payment_id. */
export const getOrderPayments = ({ creds, orderId }) =>
  call({ creds, path: `/orders/${encodeURIComponent(orderId)}/payments` });

export const createRefund = ({ creds, orderId, refundId, amountRupees, note }) =>
  call({
    creds,
    method: 'POST',
    path: `/orders/${encodeURIComponent(orderId)}/refunds`,
    body: { refund_id: refundId, refund_amount: amountRupees, refund_note: note?.slice(0, 100) },
    idempotencyKey: refundId,
  });

/**
 * Credential check without side effects: look up an order id that cannot
 * exist. 404 means Cashfree accepted the keys; 401/403 means it did not.
 */
export const verifyCredentials = async ({ creds }) => {
  try {
    await getOrder({ creds, orderId: `mediigo_keycheck_${Date.now()}` });
    return { ok: true };
  } catch (err) {
    if (err.gatewayStatus === 404) return { ok: true };
    if (err.gatewayStatus === 401 || err.gatewayStatus === 403) return { ok: false, message: 'Cashfree rejected these keys' };
    return { ok: false, message: err.message };
  }
};

/**
 * Webhook signature: base64(HMAC-SHA256(timestamp + rawBody, secretKey)),
 * compared in constant time. Must be computed over the body exactly as
 * received — re-serialising parsed JSON changes the bytes and fails.
 */
export const verifyWebhookSignature = ({ rawBody, timestamp, signature, secretKey }) => {
  if (!rawBody || !timestamp || !signature || !secretKey) return false;
  const expected = crypto.createHmac('sha256', secretKey).update(`${timestamp}${rawBody}`).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
