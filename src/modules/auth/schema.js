import { z } from 'zod';
import { OTP_PURPOSE } from '../../config/constants.js';

const phone = z.string().min(10).max(15);
const newPassword = z.string().min(8, 'Password must be at least 8 characters').max(72);

// STAFF_2FA is deliberately absent: only passwordLogin may issue that code,
// after the password has been checked. Accepting it here let anyone holding
// the phone skip the password entirely.
export const requestOtpSchema = {
  body: z.object({
    phone,
    purpose: z.enum([OTP_PURPOSE.PATIENT_LOGIN, OTP_PURPOSE.STAFF_LOGIN, OTP_PURPOSE.PASSWORD_RESET]).optional(),
  }),
};

export const resetPasswordSchema = {
  body: z.object({
    phone,
    otp: z.string().min(4).max(8),
    newPassword,
  }),
};

export const verifyOtpSchema = {
  body: z.object({
    phone,
    otp: z.string().min(4).max(8),
    purpose: z.enum([OTP_PURPOSE.PATIENT_LOGIN, OTP_PURPOSE.STAFF_LOGIN, OTP_PURPOSE.STAFF_2FA]).optional(),
    name: z.string().trim().min(1).max(80).optional(),
  }),
};

export const staffLoginSchema = {
  body: z.object({
    identifier: z.string().min(3),
    password: z.string().min(1),
  }),
};

export const changePasswordSchema = {
  body: z.object({
    currentPassword: z.string().max(72).optional(),
    newPassword,
  }),
};

export const refreshSchema = {
  body: z.object({ refreshToken: z.string().optional() }),
};
