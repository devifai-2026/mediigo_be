// All money comparisons happen in integer paise. Comparing rupee floats is how
// a ₹0.01 drift silently fails a tender assertion that should pass — or worse,
// passes one that should fail.

export const paise = (rupees) => Math.round(Number(rupees || 0) * 100);

export const rupees = (p) => Number(p || 0) / 100;

export const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// The split-POS invariant: cash + upi + card must exactly equal the total.
export const tenderTotalPaise = (tender = {}) =>
  paise(tender.cash) + paise(tender.upi) + paise(tender.card);

export const isTenderBalanced = (tender, totalFee) => tenderTotalPaise(tender) === paise(totalFee);
