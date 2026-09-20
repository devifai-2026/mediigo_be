// Phone normalization. The canonical stored form is the last 10 digits; WABridge
// wants 91-prefixed. Keeping both conversions here means the console driver and
// the wabridge driver can never disagree about what a number is.

export const last10Digits = (raw) => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

export const isValidIndianMobile = (raw) => /^[6-9]\d{9}$/.test(last10Digits(raw));

// WABridge expects 91 + last-10 for Indian numbers. Ported verbatim from the
// proven Extraeedge implementation.
export const toWaNumber = (raw) => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `91${digits}` : digits;
};

export const toE164 = (raw) => {
  const d = last10Digits(raw);
  return d.length === 10 ? `+91${d}` : '';
};
