import { z } from 'zod';

export const nearbySchema = {
  query: z.object({
    lng: z.coerce.number().min(-180).max(180),
    lat: z.coerce.number().min(-90).max(90),
    radiusKm: z.coerce.number().min(0.1).max(50).optional(),
    specialty: z.string().max(60).optional(),
    search: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};

export const feesSchema = {
  body: z.object({
    fresh: z.coerce.number().min(0),
    followup: z.coerce.number().min(0),
    emergency: z.coerce.number().min(0),
  }),
};

export const profileSchema = {
  body: z.object({
    name: z.string().trim().min(2).max(80).optional(),
    specialty: z.string().trim().min(2).max(60).optional(),
    chamberNumber: z.string().max(20).optional(),
    qualifications: z.array(z.string().max(40)).max(10).optional(),
    languages: z.array(z.string().max(30)).max(10).optional(),
    avgConsultMinutes: z.coerce.number().int().min(1).max(120).optional(),
  }),
};
