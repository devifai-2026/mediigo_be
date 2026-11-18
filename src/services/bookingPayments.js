import crypto from 'node:crypto';
import { PaymentSettings, BookingPayment, OPDToken, User } from '../models/index.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { appError, conflict, notFound, forbidden, validationError } from '../lib/errors.js';
import { encryptSecret, decryptSecret, canEncrypt, hintOf } from '../lib/secretBox.js';
import { last10Digits } from '../lib/phone.js';
import * as cashfree from '../lib/providers/cashfree.js';
import { bookToken } from '../modules/queue/service.js';
import { AUDIT_ACTIONS, BOOKING_PAYMENT_STATUS as S, RESPONSE_CODES, ROLES } from '../config/constants.js';

/**
 * The online booking fee: a patient pays Mediigo (via Cashfree) before their
 * token is issued. The consultation fee is untouched and still paid at the desk.
 *
 * Flow — pay first, then book:
 *   1. startBookingPayment dry-runs the booking, then creates a Cashfree order
 *      that expires on its own (order_expiry_time) if it is never paid.
 *   2. The patient pays in Cashfree's checkout.
 *   3. fulfil() runs from whichever arrives first — the browser's confirm call
 *      or Cashfree's webhook — re-reads the order from Cashfree (never trusting
 *      the caller), and creates the token.
 *   4. If the token can no longer be created (someone took the slot while they
 *      paid), the fee is refunded through Cashfree straight away.
 *
 * No slot is held during payment. Holding one would need a pending token
 * status that every queue screen understands, plus a sweeper to free it; the
 * refund in step 4 covers the rare collision instead.
 */

const MODES = ['sandbox', 'production'];
// Cashfree needs an expiry comfortably in the future; 20 minutes is plenty to
// finish a UPI payment and short enough that a stale order cannot linger.
const ORDER_TTL_MS = 20 * 60_000;
// A PROCESSING claim older than this is treated as abandoned and retaken.
const STALE_CLAIM_MS = 2 * 60_000;

// ---------------------------------------------------------------- settings

const SECRET_FIELDS = MODES.flatMap((m) => [`+${m}.appIdEnc`, `+${m}.secretKeyEnc`]).join(' ');
const CACHE_TTL_MS = 30_000;
let cache = { value: null, at: 0 };
const bust = () => { cache = { value: null, at: 0 }; };

const loadSettings = async ({ fresh = false } = {}) => {
  if (!fresh && cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const doc = await PaymentSettings.findById('singleton').select(SECRET_FIELDS).lean();
  const value = {
    enabled: false, mode: 'sandbox', bookingFeePaise: 1000,
    ...(doc || {}),
    sandbox: { ...(doc?.sandbox || {}) },
    production: { ...(doc?.production || {}) },
  };
  cache = { value, at: Date.now() };
  return value;
};

const isConfigured = (s, mode) => Boolean(s[mode]?.appIdEnc && s[mode]?.secretKeyEnc);

const credsFor = (s, mode) => {
  const appId = decryptSecret(s[mode]?.appIdEnc);
  const secretKey = decryptSecret(s[mode]?.secretKeyEnc);
  if (!appId || !secretKey) {
    throw appError({
      status: 503, code: RESPONSE_CODES.PAYMENTS_NOT_CONFIGURED,
      message: `Cashfree ${mode} keys are missing or unreadable — re-enter them in Super Admin → Payment Gateway`,
    });
  }
  return { mode, appId, secretKey };
};

export const webhookUrl = () => `${env.BASE_URL.replace(/\/$/, '')}/api/payments/cashfree/webhook`;

/** What Super Admin sees. Never a key — only whether one is saved and its last four. */
export const readPaymentSettings = async () => {
  const s = await loadSettings({ fresh: true });
  const side = (m) => ({
    configured: isConfigured(s, m),
    appIdHint: s[m]?.appIdHint || '',
    secretKeySet: Boolean(s[m]?.secretKeyEnc),
    updatedAt: s[m]?.updatedAt || null,
  });
  return {
    enabled: s.enabled,
    mode: s.mode,
    bookingFeePaise: s.bookingFeePaise,
    sandbox: side('sandbox'),
    production: side('production'),
    encryptionReady: canEncrypt(),
    webhookUrl: webhookUrl(),
    updatedAt: s.updatedAt || null,
  };
};

export const updatePaymentSettings = async ({ patch, actor, ip, userAgent }) => {
  const current = await loadSettings({ fresh: true });
  const $set = { updatedBy: actor.id };
  if (patch.enabled !== undefined) $set.enabled = patch.enabled;
  if (patch.mode !== undefined) $set.mode = patch.mode;
  if (patch.bookingFeePaise !== undefined) $set.bookingFeePaise = patch.bookingFeePaise;

  const touched = [];
  for (const m of MODES) {
    const appId = patch[m]?.appId?.trim();
    const secretKey = patch[m]?.secretKey?.trim();
    // Blank means "keep what is saved" — the form never sees the saved value.
    if (!appId && !secretKey) continue;
    if (appId) {
      $set[`${m}.appIdEnc`] = encryptSecret(appId);
      $set[`${m}.appIdHint`] = hintOf(appId);
    }
    if (secretKey) {
      $set[`${m}.secretKeyEnc`] = encryptSecret(secretKey);
      $set[`${m}.secretKeySet`] = true;
    }
    $set[`${m}.updatedAt`] = new Date();
    touched.push(m);
  }

  // Refuse to switch the fee on against a key set that is not there: every
  // patient booking would fail at the payment step.
  const nextEnabled = $set.enabled ?? current.enabled;
  const nextMode = $set.mode ?? current.mode;
  const willHave = (m) => Boolean(($set[`${m}.appIdEnc`] || current[m]?.appIdEnc)
    && ($set[`${m}.secretKeyEnc`] || current[m]?.secretKeyEnc));
  if (nextEnabled && !willHave(nextMode)) {
    throw validationError([{ path: [nextMode], message: `Add the Cashfree ${nextMode} App ID and Secret Key before turning the booking fee on` }]);
  }

  await PaymentSettings.updateOne({ _id: 'singleton' }, { $set }, { upsert: true });
  bust();
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PAYMENT_SETTINGS_UPDATED,
    entityType: 'PaymentSettings', entityId: 'singleton',
    before: { enabled: current.enabled, mode: current.mode, bookingFeePaise: current.bookingFeePaise },
    after: { enabled: $set.enabled, mode: $set.mode, bookingFeePaise: $set.bookingFeePaise, keysChanged: touched },
    ip, userAgent,
  });
  return readPaymentSettings();
};

/** Super Admin's "Test keys" button: does Cashfree accept the saved keys for this mode? */
export const testCredentials = async ({ mode }) => {
  const s = await loadSettings({ fresh: true });
  if (!isConfigured(s, mode)) return { ok: false, message: `No ${mode} keys saved yet` };
  return cashfree.verifyCredentials({ creds: credsFor(s, mode) });
};

/** What the booking screen needs to know: is there a fee, and how much. */
export const bookingFeeInfo = async () => {
  const s = await loadSettings();
  const required = Boolean(s.enabled && isConfigured(s, s.mode));
  return { required, amountPaise: required ? s.bookingFeePaise : 0, mode: s.mode };
};

/** Used by /api/queue/book: a patient cannot skip the fee by calling it directly. */
export const assertNoFeeRequired = async () => {
  const { required } = await bookingFeeInfo();
  if (required) {
    throw appError({ status: 402, code: RESPONSE_CODES.PAYMENT_REQUIRED, message: 'Online booking needs the booking fee to be paid first' });
  }
};

// ---------------------------------------------------------------- orders

const newOrderId = () => `MGB${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

/** Where Cashfree sends the browser back for redirect-based payment methods. */
const returnBaseFor = (origin) => {
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, '');
  try {
    const u = new URL(origin);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    const open = env.CORS_ORIGINS.length === 0 || env.CORS_ORIGINS.includes('*');
    return open || env.CORS_ORIGINS.includes(u.origin) ? u.origin : null;
  } catch {
    return null;
  }
};

const view = async (bp) => ({
  orderId: bp.orderId,
  status: bp.status,
  amountPaise: bp.amountPaise,
  mode: bp.mode,
  failureReason: bp.failureReason || '',
  token: bp.tokenId ? await OPDToken.findById(bp.tokenId).lean() : null,
});

export const startBookingPayment = async ({ request, user, origin }) => {
  const s = await loadSettings({ fresh: true });
  if (!s.enabled || !isConfigured(s, s.mode)) {
    throw conflict('Online payment is not switched on — book without paying', RESPONSE_CODES.CONFLICT);
  }
  const creds = credsFor(s, s.mode);

  // Every check a real booking makes, before any money moves.
  await bookToken({ ...request, patientId: user.id, actor: user, dryRun: true });

  const patient = await User.findById(user.id).select('name phone').lean();
  if (!patient) throw notFound('Patient not found');
  const phone = last10Digits(patient.phone || '');
  if (phone.length !== 10) throw validationError([{ path: ['phone'], message: 'Add a mobile number to your account before paying' }]);

  const orderId = newOrderId();
  const expiresAt = new Date(Date.now() + ORDER_TTL_MS);
  const returnBase = returnBaseFor(origin);
  const bp = await BookingPayment.create({
    orderId, mode: s.mode, patientId: user.id, doctorId: request.doctorId,
    amountPaise: s.bookingFeePaise, request, expiresAt,
  });

  let order;
  try {
    order = await cashfree.createOrder({
      creds,
      order: {
        order_id: orderId,
        order_amount: s.bookingFeePaise / 100,
        order_currency: 'INR',
        customer_details: {
          customer_id: String(user.id),
          customer_phone: phone,
          ...(patient.name?.trim()?.length >= 3 ? { customer_name: patient.name.trim().slice(0, 100) } : {}),
        },
        order_expiry_time: expiresAt.toISOString(),
        order_note: 'Mediigo online booking fee',
        order_meta: {
          ...(returnBase ? { return_url: `${returnBase}/p/payment-return?order_id={order_id}` } : {}),
          // Cashfree only posts to https; locally the browser's confirm call does the job.
          ...(webhookUrl().startsWith('https://') ? { notify_url: webhookUrl() } : {}),
        },
        order_tags: { purpose: 'booking_fee', doctorId: String(request.doctorId) },
      },
    });
  } catch (err) {
    await BookingPayment.updateOne({ _id: bp._id }, { $set: { status: S.EXPIRED, failureReason: 'Order could not be created' } });
    throw err;
  }

  await BookingPayment.updateOne({ _id: bp._id }, { $set: { cfOrderId: String(order.cf_order_id ?? '') } });
  return {
    orderId,
    paymentSessionId: order.payment_session_id,
    mode: s.mode,
    amountPaise: s.bookingFeePaise,
    expiresAt,
  };
};

const TERMINAL = [S.BOOKED, S.REFUNDED, S.REFUND_FAILED, S.EXPIRED];

/**
 * Turn a paid order into a token. Idempotent and safe to race: the browser and
 * the webhook may both call it, and only the one that wins the atomic claim
 * books. The other just reports the state.
 */
export const fulfil = async ({ orderId }) => {
  let bp = await BookingPayment.findOne({ orderId });
  if (!bp) throw notFound('Payment not found');
  if (TERMINAL.includes(bp.status)) return view(bp);
  if (bp.status === S.PROCESSING && bp.processingAt > new Date(Date.now() - STALE_CLAIM_MS)) return view(bp);

  const settings = await loadSettings();
  const creds = credsFor(settings, bp.mode);
  const order = await cashfree.getOrder({ creds, orderId });

  if (order.order_status !== 'PAID') {
    if (['EXPIRED', 'TERMINATED'].includes(order.order_status) && bp.status === S.CREATED) {
      bp = await BookingPayment.findOneAndUpdate({ _id: bp._id, status: S.CREATED }, { $set: { status: S.EXPIRED } }, { new: true }) ?? bp;
    }
    return { ...(await view(bp)), gatewayStatus: order.order_status };
  }
  // The amount is ours to check, not Cashfree's to tell us.
  if (Math.round(Number(order.order_amount) * 100) !== bp.amountPaise) {
    logger.error({ orderId, expected: bp.amountPaise, got: order.order_amount }, 'booking fee: amount mismatch');
    throw conflict('Payment amount does not match this order');
  }

  const claimed = await BookingPayment.findOneAndUpdate(
    { _id: bp._id, $or: [{ status: S.CREATED }, { status: S.PROCESSING, processingAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) } }] },
    { $set: { status: S.PROCESSING, processingAt: new Date() } },
    { new: true },
  );
  if (!claimed) return view(await BookingPayment.findById(bp._id));
  bp = claimed;

  // Which payment succeeded — for the record and support queries; not critical.
  let cfPaymentId = '';
  let paymentMethod = '';
  try {
    const payments = await cashfree.getOrderPayments({ creds, orderId });
    const ok = (Array.isArray(payments) ? payments : []).find((p) => p.payment_status === 'SUCCESS');
    cfPaymentId = ok?.cf_payment_id ? String(ok.cf_payment_id) : '';
    paymentMethod = ok?.payment_group || '';
  } catch (err) {
    logger.warn({ orderId, err: err.message }, 'booking fee: could not read payment details');
  }
  const paidAt = new Date();

  try {
    const token = await bookToken({
      ...bp.request,
      patientId: bp.patientId,
      actor: { id: bp.patientId, role: ROLES.PATIENT },
      bookingFee: { amountPaise: bp.amountPaise, orderId, cfPaymentId, mode: bp.mode, paidAt },
    });
    bp = await BookingPayment.findByIdAndUpdate(bp._id, {
      $set: { status: S.BOOKED, tokenId: token._id, cfPaymentId, paymentMethod, paidAt },
    }, { new: true });
    writeAuditLog({
      actorId: bp.patientId, actorRole: ROLES.PATIENT, action: AUDIT_ACTIONS.BOOKING_FEE_PAID,
      entityType: 'OPDToken', entityId: token._id,
      after: { orderId, amountPaise: bp.amountPaise, mode: bp.mode, cfPaymentId },
    });
    return view(bp);
  } catch (err) {
    // Paid, but no token: give the money back now rather than leave it with us.
    const failureReason = err?.message || 'The booking could not be completed';
    logger.warn({ orderId, err: failureReason }, 'booking fee: paid but booking failed, refunding');
    const refundId = `RF${orderId}`.slice(0, 40);
    let status = S.REFUNDED;
    try {
      await cashfree.createRefund({
        creds, orderId, refundId, amountRupees: bp.amountPaise / 100, note: 'Booking could not be completed',
      });
    } catch (refundErr) {
      status = S.REFUND_FAILED;
      logger.error({ orderId, err: refundErr.message }, 'booking fee: REFUND FAILED — needs manual refund in Cashfree');
    }
    bp = await BookingPayment.findByIdAndUpdate(bp._id, {
      $set: {
        status, failureReason, cfPaymentId, paymentMethod, paidAt,
        refundId: status === S.REFUNDED ? refundId : '',
        refundedAt: status === S.REFUNDED ? new Date() : null,
      },
    }, { new: true });
    writeAuditLog({
      actorId: bp.patientId, actorRole: ROLES.PATIENT, action: AUDIT_ACTIONS.BOOKING_FEE_REFUNDED,
      entityType: 'BookingPayment', entityId: bp._id,
      after: { orderId, status, failureReason, refundId: bp.refundId },
    });
    return view(bp);
  }
};

/** The patient's own confirm call after checkout closes. */
export const confirmForPatient = async ({ orderId, user }) => {
  const bp = await BookingPayment.findOne({ orderId }).select('patientId').lean();
  if (!bp) throw notFound('Payment not found');
  if (String(bp.patientId) !== String(user.id)) throw forbidden('This payment belongs to another account');
  return fulfil({ orderId });
};

/**
 * Cashfree's server-to-server notification. Verified against the secret of the
 * mode the order was created in, then handed to fulfil(), which re-reads the
 * order from Cashfree — the payload itself is never trusted for state.
 */
export const handleWebhook = async ({ rawBody, timestamp, signature }) => {
  let payload;
  try { payload = JSON.parse(rawBody || '{}'); } catch { return { status: 400, message: 'bad json' }; }
  const orderId = payload?.data?.order?.order_id;
  if (!orderId) return { status: 200, message: 'ignored' };

  const bp = await BookingPayment.findOne({ orderId }).select('mode').lean();
  if (!bp) return { status: 200, message: 'unknown order' };

  const settings = await loadSettings();
  const { secretKey } = credsFor(settings, bp.mode);
  if (!cashfree.verifyWebhookSignature({ rawBody, timestamp, signature, secretKey })) {
    logger.warn({ orderId }, 'cashfree webhook: bad signature');
    return { status: 401, message: 'bad signature' };
  }
  if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK') await fulfil({ orderId });
  return { status: 200, message: 'ok' };
};

/** Recent booking-fee payments for Super Admin, newest first. */
export const recentPayments = async ({ limit = 50 } = {}) => BookingPayment.find()
  .sort({ createdAt: -1 })
  .limit(limit)
  .select('-request')
  .populate('patientId', 'name phone')
  .lean();
