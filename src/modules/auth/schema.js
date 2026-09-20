import { z } from 'zod';
import { OTP_PURPOSE } from '../../config/constants.js';

const phone = z.string().min(10).max(15);

export const requestOtpSchema = {
  body: z.object({
    phone,
    purpose: z.enum([OTP_PURPOSE.PATIENT_LOGIN, OTP_PURPOSE.STAFF_LOGIN, OTP_PURPOSE.STAFF_2FA]).optional(),
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

export const refreshSchema = {
  body: z.object({ refreshToken: z.string().optional() }),
};
