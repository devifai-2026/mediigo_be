import { z } from 'zod';
import { VISIT_TYPE } from '../../config/constants.js';

const money = z.coerce.number().min(0).default(0);

const tender = z.object({ cash: money, upi: money, card: money });

export const walkinSchema = {
  body: z.object({
    doctorId: z.string().min(1),
    patientId: z.string().optional(),
    familyMemberId: z.string().optional().nullable(),
    patient: z
      .object({
        name: z.string().trim().min(1).max(80),
        phone: z.string().optional(),
        age: z.coerce.number().int().min(0).max(130).optional(),
        gender: z.enum(['M', 'F', 'O']).optional(),
        complaint: z.string().max(200).optional(),
      })
      .optional(),
    visitType: z.enum(Object.values(VISIT_TYPE)).default(VISIT_TYPE.FRESH),
    discount: money,
    tender,
    upiRef: z.string().max(60).optional(),
    cardLast4: z.string().regex(/^\d{4}$/).optional(),
    idempotencyKey: z.string().max(64).optional(),
  }),
};

export const paySchema = {
  body: z.object({
    discount: money,
    tender,
    upiRef: z.string().max(60).optional(),
    cardLast4: z.string().regex(/^\d{4}$/).optional(),
    idempotencyKey: z.string().max(64).optional(),
  }),
};

export const dayCloseSchema = {
  query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
};
