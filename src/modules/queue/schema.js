import { z } from 'zod';
import { TOKEN_STATUS, VISIT_TYPE, BREAK_REASONS, BREAK_DURATIONS } from '../../config/constants.js';

export const queryDate = {
  query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
};

export const statusSchema = {
  body: z.object({
    status: z.enum([TOKEN_STATUS.IN_CHAMBER, TOKEN_STATUS.COMPLETED, TOKEN_STATUS.SKIPPED, TOKEN_STATUS.WAITING]),
    reason: z.string().max(200).optional(),
  }),
};

export const breakSchema = {
  body: z.object({
    reason: z.enum(BREAK_REASONS),
    minutes: z.coerce.number().refine((v) => BREAK_DURATIONS.includes(v), {
      message: `Duration must be one of: ${BREAK_DURATIONS.join(', ')}`,
    }),
  }),
};

export const bookSchema = {
  body: z.object({
    doctorId: z.string().min(1),
    familyMemberId: z.string().optional().nullable(),
    visitType: z.enum(Object.values(VISIT_TYPE)).default(VISIT_TYPE.FRESH),
  }),
};

export const bookingOpenSchema = {
  body: z.object({ isOpen: z.boolean() }),
};
