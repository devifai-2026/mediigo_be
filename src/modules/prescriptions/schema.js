import { z } from 'zod';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

export const createSchema = {
  body: z.object({
    tokenId: objectId,
    symptoms: z.string().trim().max(500).optional(),
    diagnosis: z.string().trim().min(1, 'Diagnosis is required').max(300),
    medicines: z.array(z.object({
      name: z.string().trim().min(1).max(120),
      dosage: z.string().trim().max(40).optional().default(''),
      duration: z.string().trim().max(40).optional().default(''),
      instruction: z.string().trim().max(120).optional().default(''),
    })).min(1, 'Add at least one medicine').max(30),
    advice: z.string().trim().max(1000).optional().default(''),
    reviewDate: z.string().regex(DATE_RE).optional().nullable(),
    totalDue: z.coerce.number().min(0).max(1000000).optional().nullable(),
    // Send to the clinic's pharmacy as part of saving.
    sendToPharmacy: z.boolean().optional().default(false),
  }),
};

export const lookupSchema = {
  query: z.object({
    phone: z.string().transform((v) => v.replace(/\D/g, '').slice(-10)).pipe(z.string().length(10, 'Enter a 10-digit mobile number')),
    visits: z.coerce.number().int().min(1).max(50).optional(),
  }),
};

export const listSchema = {
  query: z.object({
    patientId: objectId.optional(),
    tokenId: objectId.optional(),
    doctorId: objectId.optional(),
    date: z.string().regex(DATE_RE).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};

export const suggestSchema = {
  query: z.object({ q: z.string().trim().max(60).optional().default('') }),
};
