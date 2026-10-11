import mongoose from 'mongoose';

/**
 * Cash paid OUT of the desk drawer for small clinic expenses.
 *
 * It reduces cash-in-hand at day close, so it is money and is treated like
 * money: never edited, never deleted. A mistaken entry is voided, which keeps
 * the row (and who voided it, and why) in the ledger.
 */
const pettyExpenseSchema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    date: { type: String, required: true },
    amount: { type: Number, required: true, min: 1 },
    category: { type: String, required: true, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 300, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['ACTIVE', 'VOID'], default: 'ACTIVE' },
    void: {
      reason: String,
      at: Date,
      byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
  },
  { timestamps: true },
);

pettyExpenseSchema.index({ hospitalId: 1, date: 1 });

export const PettyExpense = mongoose.model('PettyExpense', pettyExpenseSchema);
