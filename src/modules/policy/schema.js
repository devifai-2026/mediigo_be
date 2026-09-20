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

export const hashParam = {
  params: z.object({ aadhaarHash: z.string().length(64) }),
};
