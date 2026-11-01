import { z } from 'zod';
import { PLAN_TYPE } from '../../config/constants.js';

export const lookupSchema = {
  body: z.object({ aadhaarNumber: z.string().min(12).max(14) }),
};

export const addPolicySchema = {
  body: z.object({
    aadhaarNumber: z.string().min(12).max(14).optional(),
    aadhaarHash: z.string().length(64).optional(),
    holderName: z.string().max(80).optional(),
    insurerName: z.string().min(2).max(80),
    policyNumber: z.string().min(2).max(60),
    distributorName: z.string().max(80).optional(),
    planType: z.enum(Object.values(PLAN_TYPE)),
    sumInsured: z.coerce.number().min(0),
    deductible: z.coerce.number().min(0).optional(),
    roomRentCapDaily: z.coerce.number().min(0).nullable().optional(),
    roomRentCapPct: z.coerce.number().min(0).max(100).nullable().optional(),
    icuCapDaily: z.coerce.number().min(0).nullable().optional(),
    copayPct: z.coerce.number().min(0).max(100).optional(),
    riders: z.array(z.string().max(40)).max(10).optional(),
    premiumAnnual: z.coerce.number().min(0).optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
  }),
};

// Only the policy's own terms can be edited. Unchecked, the body went straight
// into $set — so a patient could re-point patientId and take over a policy.
export const updatePolicySchema = {
  params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid policy id') }),
  body: addPolicySchema.body.omit({ aadhaarNumber: true, aadhaarHash: true }).partial().strict()
    .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
};

export const hashParam = {
  params: z.object({ aadhaarHash: z.string().length(64) }),
};
