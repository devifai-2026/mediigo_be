import mongoose from 'mongoose';
import { VISIT_TYPE } from '../config/constants.js';
import { isTenderBalanced } from '../lib/money.js';

const transactionSchema = new mongoose.Schema(
  {
    tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'OPDToken', required: true },
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },

    visitType: { type: String, enum: Object.values(VISIT_TYPE) },
    baseFee: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    totalFee: { type: Number, required: true, min: 0 },

    // Split tender. The invariant cash + upi + card === totalFee is asserted in
    // the service AND again here, because a second line of defence on money is
    // cheap and a silent imbalance is not recoverable after the fact.
    tender: {
      cash: { type: Number, default: 0, min: 0 },
      upi: { type: Number, default: 0, min: 0 },
      card: { type: Number, default: 0, min: 0 },
    },
    upiRef: String,
    cardLast4: String,

    // Per-hospital, per-financial-year sequence. A global sequence would be
    // wrong for GST/audit — each clinic books its own numbered series.
    receiptNumber: { type: String, required: true },
    receiptSeq: { type: Number, required: true },
    fy: { type: String, required: true },

    collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['PAID', 'REFUNDED', 'VOID'], default: 'PAID' },
    refund: {
      amount: Number,
      reason: String,
      at: Date,
      byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: true },
);

transactionSchema.index({ tokenId: 1 }, { unique: true });
transactionSchema.index({ hospitalId: 1, receiptNumber: 1 }, { unique: true });
transactionSchema.index({ hospitalId: 1, date: 1 });
transactionSchema.index({ collectedBy: 1, date: 1 });
// Guards against a double-tap or a retry-after-timeout billing twice.
transactionSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

transactionSchema.pre('validate', function assertTenderBalanced(next) {
  if (!isTenderBalanced(this.tender, this.totalFee)) {
    next(new Error('Tender split must exactly equal totalFee'));
    return;
  }
  next();
});

export const Transaction = mongoose.model('Transaction', transactionSchema);
