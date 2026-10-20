import { SHIFT } from '../../config/constants.js';
import { z } from 'zod';
import { profilePatchSchema } from './profileFields.js';

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

export const suggestSchema = {
  query: z.object({
    q: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(20).optional(),
  }),
};

export const feesSchema = {
  body: z.object({
    fresh: z.coerce.number().min(0),
    followup: z.coerce.number().min(0),
    emergency: z.coerce.number().min(0),
  }),
};

// Editable fields plus the locked credentials; the service refuses the
// locked ones to anyone but a super admin.
export const profileSchema = { body: profilePatchSchema };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const scheduleSchema = {
  body: z.object({
    schedule: z.array(
      z.object({
        day: z.coerce.number().int().min(0).max(6),
        shift: z.enum(Object.values(SHIFT)).optional(),
        startTime: z.string().regex(TIME_RE, 'Use HH:mm'),
        endTime: z.string().regex(TIME_RE, 'Use HH:mm'),
        // Optional: leave it out for an uncapped sitting.
        maxTokens: z.coerce.number().int().min(1).nullable().optional(),
        isActive: z.boolean().optional(),
      }).refine((s) => s.startTime < s.endTime, {
        message: 'A sitting must end after it starts',
        path: ['endTime'],
      }),
    ).max(30),
  }),
};

export const markOffSchema = {
  body: z.object({
    date: z.string().regex(DATE_RE, 'Expected YYYY-MM-DD'),
    shift: z.enum(Object.values(SHIFT)).nullable().optional(),
    reason: z.string().max(300).optional(),
  }),
};

export const slotsSchema = {
  query: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
    shift: z.enum(Object.values(SHIFT)),
  }),
};
