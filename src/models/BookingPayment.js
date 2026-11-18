import mongoose from 'mongoose';
import { BOOKING_PAYMENT_STATUS } from '../config/constants.js';

/**
 * One online booking-fee payment: a Cashfree order, and the booking it pays for.
 *
 * The patient pays BEFORE the token exists, so the booking request is kept
 * here verbatim and replayed once Cashfree says the order is paid. That way a
 * patient who closes the tab mid-payment still gets their token from the
 * webhook, and a token is never handed out for money that never arrived.
 */
const bookingPaymentSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true },
    cfOrderId: { type: String, default: '' },
    // Which key set created the order — webhooks and refunds must use the same.
    mode: { type: String, enum: ['sandbox', 'production'], required: true },

    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    amountPaise: { type: Number, required: true, min: 1 },

    // The validated /api/queue/book body, replayed after payment.
    request: { type: mongoose.Schema.Types.Mixed, required: true },

    status: {
      type: String,
      enum: Object.values(BOOKING_PAYMENT_STATUS),
      default: BOOKING_PAYMENT_STATUS.CREATED,
    },
    // When PROCESSING was claimed. A claim older than a couple of minutes is
    // treated as abandoned (the process died mid-booking) and can be retaken.
    processingAt: { type: Date, default: null },

    tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'OPDToken', default: null },
    cfPaymentId: { type: String, default: '' },
    paymentMethod: { type: String, default: '' },
    paidAt: { type: Date, default: null },

    // Why the token could not be created after payment, shown to the patient.
    failureReason: { type: String, default: '' },
    refundId: { type: String, default: '' },
    refundedAt: { type: Date, default: null },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

bookingPaymentSchema.index({ patientId: 1, createdAt: -1 });
bookingPaymentSchema.index({ status: 1, createdAt: -1 });

export const BookingPayment = mongoose.model('BookingPayment', bookingPaymentSchema);
