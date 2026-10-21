import { z } from 'zod';

/**
 * The one definition of a doctor's profile fields.
 *
 * Onboarding validates against it, approval copies through it, and the profile
 * editor patches with it. Before this, each of those kept its own list, and
 * they had drifted: the add-doctor form collected experience that approval
 * silently dropped, and the patient page rendered sections — about, conditions,
 * education, memberships — that no form could ever fill.
 */

const text = (max) => z.string().trim().max(max);
// List fields arrive from one-per-line textareas; blanks are noise, not entries.
const lines = (maxItems, maxLen) => z.array(text(maxLen)).max(maxItems)
  .transform((a) => a.filter(Boolean));

/** What the clinic, the doctor and the admins may change at any time. */
export const editableShape = {
  name: text(80).pipe(z.string().min(2, 'Doctor name is required')),
  specialty: text(60).pipe(z.string().min(2, 'Pick a specialty')),
  // References into the specialty master. `specialty` stays the primary
  // display value; this is every specialty the doctor practises.
  specialtyIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(6),
  chamberNumber: text(20),
  qualifications: lines(10, 40),
  designation: text(80),
  experienceYears: z.coerce.number().int().min(0).max(70),
  languages: lines(10, 30),
  about: text(2000),
  conditionsTreated: lines(40, 80),
  proceduresPerformed: lines(40, 80),
  education: lines(15, 160),
  memberships: lines(15, 160),
  trainings: lines(15, 160),
  awards: lines(15, 160),
  publications: lines(20, 240),
  avgConsultMinutes: z.coerce.number().int().min(1).max(120),
  followupWindowDays: z.coerce.number().int().min(0).max(90),
};

/**
 * Credentials. Set once at onboarding and then locked: a clinic that could
 * rewrite a registration number could quietly swap in someone else's licence.
 * Only a super admin may correct them, and every correction is audited.
 */
export const lockedShape = {
  councilRegNo: text(40).pipe(z.string().min(3, 'Council registration number is required')),
  registrationCouncil: text(120),
  registrationYear: z.coerce.number().int().min(1950).max(new Date().getFullYear()),
};

export const LOCKED_FIELDS = Object.keys(lockedShape);

export const profilePatchSchema = z.object({ ...editableShape, ...lockedShape }).partial();

/** A DOCTOR onboarding payload, checked when it is sent for review. */
export const doctorPayloadSchema = z.object({
  ...Object.fromEntries(Object.entries(editableShape).map(([k, v]) => [k, v.optional()])),
  ...lockedShape,
  registrationYear: lockedShape.registrationYear.optional(),
  name: editableShape.name,
  specialty: editableShape.specialty,
  registrationCouncil: z.string({ required_error: 'Medical council is required' }).trim().max(120).min(2, 'Medical council is required'),
  hospitalId: z.string().regex(/^[a-f0-9]{24}$/i, 'Pick the clinic'),
  phone: z.string().trim().regex(/^\d{10}$/, 'Enter a 10-digit mobile number'),
  fees: z.object({
    fresh: z.coerce.number().min(0),
    followup: z.coerce.number().min(0),
    emergency: z.coerce.number().min(0),
  }),
});

/**
 * The same, for approval. Submissions filed before the council was asked for
 * are still in review queues; refusing them now would strand those doctors.
 */
export const doctorApprovalSchema = doctorPayloadSchema.extend({
  registrationCouncil: lockedShape.registrationCouncil.optional(),
});

// ---- Clinic onboarding with its doctors -----------------------------------

export const FACILITIES = [
  'In-house Pharmacy', 'Pathology / Blood Lab', 'Digital X-Ray / ECG', 'AC Waiting Lounge',
  'Ambulance Service', 'Free Wi-Fi for Patients', 'Wheelchair Accessible', 'Power Backup (Generator)',
  'Parking', 'Cashless / Insurance',
];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const sitting = z.object({
  enabled: z.boolean(),
  startTime: z.string().regex(TIME_RE, 'Use HH:mm'),
  endTime: z.string().regex(TIME_RE, 'Use HH:mm'),
}).refine((s) => !s.enabled || s.startTime < s.endTime, { message: 'A shift must end after it starts', path: ['endTime'] });

/**
 * The clinic's OPD pattern, captured once at onboarding and applied to every
 * doctor as their starting weekly schedule. Each doctor edits their own later.
 */
export const opdSchema = z.object({
  days: z.array(z.coerce.number().int().min(0).max(6)).min(1, 'Pick at least one OPD day').max(7),
  morning: sitting,
  evening: sitting,
  avgConsultMinutes: z.coerce.number().int().min(3).max(60),
  maxTokensPerShift: z.coerce.number().int().min(1).max(500).nullable().optional(),
}).refine((o) => o.morning.enabled || o.evening.enabled, { message: 'Turn on at least one shift', path: ['morning'] })
  .refine((o) => !(o.morning.enabled && o.evening.enabled) || o.morning.endTime <= o.evening.startTime, {
    message: 'The evening shift must start after the morning shift ends', path: ['evening', 'startTime'],
  });

const photoRef = z.object({ url: z.string().min(1), objectPath: z.string().nullable().optional() });

/** One doctor in a clinic's onboarding: the same fields as adding a doctor, minus the clinic. */
export const clinicDoctorSchema = doctorPayloadSchema.omit({ hospitalId: true }).extend({
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(120).optional().or(z.literal('')),
  // Sees the whole clinic's revenue and footfall, not just their own.
  isClinicAdmin: z.boolean().optional().default(false),
  photo: photoRef.nullable().optional(),
});

export const clinicExtrasSchema = z.object({
  contactPhone: z.string().trim().regex(/^\d{10}$/, 'Clinic contact number must be 10 digits').optional(),
  contactEmail: z.string().trim().toLowerCase().email('Enter a valid clinic email').max(120).optional().or(z.literal('')),
  consultationRooms: z.coerce.number().int().min(0).max(200).optional(),
  facilities: z.array(z.enum(FACILITIES)).max(FACILITIES.length).optional(),
  opd: opdSchema.optional(),
  receptionistEmail: z.string().trim().toLowerCase().email('Enter a valid receptionist email').max(120).optional().or(z.literal('')),
  doctors: z.array(clinicDoctorSchema).max(15, 'Up to 15 doctors per submission').optional(),
});

/** The weekly schedule rows an OPD pattern produces for one doctor. */
export const scheduleFromOpd = (opd) => {
  if (!opd) return [];
  const shifts = [
    opd.morning?.enabled && { shift: 'MORNING', ...opd.morning },
    opd.evening?.enabled && { shift: 'EVENING', ...opd.evening },
  ].filter(Boolean);
  return opd.days.flatMap((day) => shifts.map((s) => ({
    day, shift: s.shift, startTime: s.startTime, endTime: s.endTime,
    maxTokens: opd.maxTokensPerShift ?? null, isActive: true,
  })));
};
