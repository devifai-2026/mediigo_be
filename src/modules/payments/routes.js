import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ROLES } from '../../config/constants.js';
import { bookSchema } from '../queue/schema.js';
import {
  bookingFeeInfo, startBookingPayment, confirmForPatient, handleWebhook,
} from '../../services/bookingPayments.js';

/** Online booking fee (Cashfree). See services/bookingPayments.js for the flow. */
export const paymentRoutes = Router();

// Cashfree → us. Unauthenticated by nature; the HMAC signature is the auth.
// Needs the body exactly as sent, which app.js keeps as req.rawBody.
paymentRoutes.post('/cashfree/webhook', asyncHandler(async (req, res) => {
  const result = await handleWebhook({
    rawBody: req.rawBody,
    timestamp: req.get('x-webhook-timestamp'),
    signature: req.get('x-webhook-signature'),
  });
  res.status(result.status).json({ ok: result.status === 200, message: result.message });
}));

const patientOnly = [requireAuth, asyncHandler(requireActiveUser), requireRole(ROLES.PATIENT)];

// Is there a fee right now, and how much — the booking sheet asks before it
// renders the button. Public: it is a price, and a signed-out visitor reading
// a doctor's page should see it too.
paymentRoutes.get('/booking-fee', asyncHandler(async (_req, res) => {
  res.json({ ok: true, data: await bookingFeeInfo() });
}));

// Same body as POST /api/queue/book. Checks the booking would succeed, then
// opens a Cashfree order for the fee. The token is created only once paid.
paymentRoutes.post(
  '/booking/order',
  ...patientOnly,
  validate(bookSchema),
  asyncHandler(async (req, res) => {
    const data = await startBookingPayment({ request: req.body, user: req.user, origin: req.get('origin') || '' });
    res.status(201).json({ ok: true, data });
  }),
);

// After checkout closes (or on the return page): has it been paid, and is the token issued?
paymentRoutes.post(
  '/booking/:orderId/confirm',
  ...patientOnly,
  validate({ params: z.object({ orderId: z.string().regex(/^[A-Za-z0-9_-]{3,45}$/) }) }),
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await confirmForPatient({ orderId: req.params.orderId, user: req.user }) });
  }),
);
