import { Router } from 'express';
import * as controller from './controller.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, forbidImpersonation } from '../../middleware/auth.js';
import { requestOtpSchema, verifyOtpSchema, staffLoginSchema, refreshSchema, changePasswordSchema, resetPasswordSchema } from './schema.js';

export const authRoutes = Router();

authRoutes.post('/otp/request', validate(requestOtpSchema), asyncHandler(controller.requestOtp));
authRoutes.post('/otp/verify', validate(verifyOtpSchema), asyncHandler(controller.verifyOtp));
authRoutes.post('/staff/login', validate(staffLoginSchema), asyncHandler(controller.staffLogin));
authRoutes.post('/refresh', validate(refreshSchema), asyncHandler(controller.refresh));
authRoutes.post('/logout', asyncHandler(controller.logout));
authRoutes.get('/me', requireAuth, asyncHandler(controller.me));
authRoutes.post('/password', requireAuth, forbidImpersonation, validate(changePasswordSchema), asyncHandler(controller.changePassword));
// Forgot password: a PASSWORD_RESET code from /otp/request, then a new password.
authRoutes.post('/password/reset', validate(resetPasswordSchema), asyncHandler(controller.resetPassword));
