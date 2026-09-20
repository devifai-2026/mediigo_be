import { Router } from 'express';
import { z } from 'zod';
import { User, OPDToken } from '../../models/index.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { notFound } from '../../lib/errors.js';
import { aadhaarHash, isValidAadhaar } from '../../lib/crypto.js';
import { backfillPatientLink } from '../policy/service.js';
import { ROLES } from '../../config/constants.js';

export const patientRoutes = Router();
patientRoutes.use(requireAuth, asyncHandler(requireActiveUser));

// Age and gender are required for anyone who can be booked: a doctor reading
// the roster needs them, and a paediatric or gynaecology token is meaningless
// without them. Stored as dob so the age stays right next year.
const notFuture = (d) => d.getTime() <= Date.now();
const plausibleDob = (d) => d.getFullYear() > new Date().getFullYear() - 130;

const memberSchema = {
  body: z.object({
    name: z.string().trim().min(1).max(80),
    relation: z.enum(['SELF', 'SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER']),
    dob: z.coerce.date({ required_error: 'Date of birth is required' })
      .refine(notFuture, 'Date of birth cannot be in the future')
      .refine(plausibleDob, 'Enter a valid date of birth'),
    gender: z.enum(['M', 'F', 'O'], { required_error: 'Gender is required' }),
    phone: z.string().optional(),
  }),
};

const profileSchema = {
  body: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    // Optional here because this is a PATCH — but a value sent must be sane.
    dob: z.coerce.date()
      .refine(notFuture, 'Date of birth cannot be in the future')
      .refine(plausibleDob, 'Enter a valid date of birth')
      .optional(),
    gender: z.enum(['M', 'F', 'O']).optional(),
    email: z.string().email().optional(),
    aadhaarNumber: z.string().min(12).max(14).optional(),
  }),
};

patientRoutes.get('/me', asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).lean();
  if (!user) throw notFound('Profile not found');
  delete user.passwordHash;
  res.json({ ok: true, data: user });
}));

patientRoutes.patch('/me', validate(profileSchema), asyncHandler(async (req, res) => {
  const patch = { ...req.body };
  // Linking an Aadhaar attaches any policies an agent captured at a camp before
  // this person had an account.
  if (patch.aadhaarNumber) {
    if (!isValidAadhaar(patch.aadhaarNumber)) throw notFound('Invalid Aadhaar number');
    const hash = aadhaarHash(patch.aadhaarNumber);
    patch.aadhaarHash = hash;
    delete patch.aadhaarNumber;
    await backfillPatientLink(req.user.id, hash);
  }
  await User.updateOne({ _id: req.user.id }, { $set: patch });
  const user = await User.findById(req.user.id).lean();
  delete user.passwordHash;
  res.json({ ok: true, data: user });
}));

// Where the patient is, so nearby search measures from them rather than a
// hardcoded city centre. They can see and change it on their profile.
patientRoutes.patch(
  '/me/location',
  validate({
    body: z.object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
      label: z.string().max(120).optional(),
      accuracy: z.coerce.number().min(0).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { lat, lng, label, accuracy } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          lastKnownLocation: {
            type: 'Point',
            coordinates: [lng, lat],
            label: label ?? '',
            accuracy: accuracy ?? null,
            updatedAt: new Date(),
          },
        },
      },
      { new: true },
    );
    if (!user) throw notFound('Patient not found');
    res.json({ ok: true, data: user.lastKnownLocation });
  }),
);

patientRoutes.get('/me/family', asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).select('familyMembers').lean();
  res.json({ ok: true, data: user?.familyMembers ?? [] });
}));

patientRoutes.post('/me/family', validate(memberSchema), asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user.id }, { $push: { familyMembers: req.body } });
  const user = await User.findById(req.user.id).select('familyMembers').lean();
  res.status(201).json({ ok: true, data: user.familyMembers });
}));

patientRoutes.patch('/me/family/:memberId', asyncHandler(async (req, res) => {
  const set = Object.fromEntries(
    Object.entries(req.body).map(([k, v]) => [`familyMembers.$[m].${k}`, v]),
  );
  await User.updateOne({ _id: req.user.id }, { $set: set }, { arrayFilters: [{ 'm._id': req.params.memberId }] });
  const user = await User.findById(req.user.id).select('familyMembers').lean();
  res.json({ ok: true, data: user.familyMembers });
}));

patientRoutes.delete('/me/family/:memberId', asyncHandler(async (req, res) => {
  await User.updateOne({ _id: req.user.id }, { $pull: { familyMembers: { _id: req.params.memberId } } });
  const user = await User.findById(req.user.id).select('familyMembers').lean();
  res.json({ ok: true, data: user.familyMembers });
}));

// Bookings list — the feature the prototype declared but never implemented.
patientRoutes.get('/me/tokens', asyncHandler(async (req, res) => {
  const filter = { patientId: req.user.id };
  if (req.query.status) filter.status = req.query.status;
  const tokens = await OPDToken.find(filter)
    .populate('doctorId', 'name specialty chamberNumber')
    .populate('hospitalId', 'name address contactPhone location')
    .sort({ date: -1, tokenNumber: -1 })
    .limit(100)
    .lean();
  res.json({ ok: true, data: tokens });
}));
