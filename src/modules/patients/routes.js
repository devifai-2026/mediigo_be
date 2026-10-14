import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { User, OPDToken } from '../../models/index.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireActiveUser } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { notFound, validationError } from '../../lib/errors.js';
import { aadhaarHash, isValidAadhaar } from '../../lib/crypto.js';
import { backfillPatientLink } from '../policy/service.js';
import { reverseGeocode } from '../../lib/providers/google-maps.js';
import { ROLES, OTP_PURPOSE } from '../../config/constants.js';
import { requestOtp, confirmPhoneChange } from '../auth/service.js';
import * as account from './account.js';
import { last10Digits, isValidIndianMobile } from '../../lib/phone.js';

export const patientRoutes = Router();
patientRoutes.use(requireAuth, asyncHandler(requireActiveUser));

// Age and gender are required for anyone who can be booked: a doctor reading
// the roster needs them, and a paediatric or gynaecology token is meaningless
// without them. Stored as dob so the age stays right next year.
const notFuture = (d) => d.getTime() <= Date.now();
const plausibleDob = (d) => d.getFullYear() > new Date().getFullYear() - 130;

// Stored as the last 10 digits, the same canonical form User.phone uses, so a
// member's number can be matched to the account that signs in with it.
const memberPhone = z.string().trim()
  .transform((v) => last10Digits(v))
  .refine((v) => v === '' || isValidIndianMobile(v), 'Enter a valid 10-digit mobile number');

const memberFields = {
  name: z.string().trim().min(1).max(80),
  relation: z.enum(['SELF', 'SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER']),
  dob: z.coerce.date({ required_error: 'Date of birth is required' })
    .refine(notFuture, 'Date of birth cannot be in the future')
    .refine(plausibleDob, 'Enter a valid date of birth'),
  gender: z.enum(['M', 'F', 'O'], { required_error: 'Gender is required' }),
  phone: memberPhone.optional(),
  conditions: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
};

const memberSchema = {
  // A child often has no phone of their own; everyone else gives one, so the
  // member can be tied to their own account.
  body: z.object(memberFields).superRefine((m, ctx) => {
    if (m.relation !== 'CHILD' && !m.phone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phone'], message: 'Mobile number is required' });
    }
  }),
};

// Edits name only what a patient may change; linkedUserId and anything else
// a client sends is dropped by the schema rather than written to the record.
const memberPatchSchema = { body: z.object(memberFields).partial() };

/** The patient account that signs in with this number, other than the caller. */
const accountFor = async (phone, selfId) => {
  if (!phone) return null;
  const u = await User.findOne({ phone, role: ROLES.PATIENT, _id: { $ne: selfId } }).select('_id').lean();
  return u?._id ?? null;
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
    // An empty string clears it; email is optional for patients.
    email: z.union([z.string().trim().toLowerCase().email('Enter a valid email address'), z.literal('')]).optional(),
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
  if (patch.email !== undefined) {
    patch.email = patch.email || null;
    await account.assertEmailFree(patch.email, req.user.id);
  }
  // The account holder's own entry in the family list carries their name.
  if (patch.name) {
    await User.updateOne(
      { _id: req.user.id },
      { $set: { 'familyMembers.$[m].name': patch.name } },
      { arrayFilters: [{ 'm.relation': 'SELF' }] },
    );
  }
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

// ---- Profile photo ----
// Memory storage: the image is resized and re-encoded before it is stored,
// and the limit makes multer abort a huge body mid-stream.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

patientRoutes.put('/me/photo', upload.single('photo'), asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await account.setPhoto({ userId: req.user.id, file: req.file }) });
}));

patientRoutes.delete('/me/photo', asyncHandler(async (req, res) => {
  res.json({ ok: true, data: await account.removePhoto({ userId: req.user.id }) });
}));

// ---- Mobile number ----
// The number is how a patient signs in, so it changes only after a code sent
// to the NEW number proves they hold it.
const phoneSchema = { body: z.object({ phone: z.string().min(10).max(14) }) };

patientRoutes.post('/me/phone/request', validate(phoneSchema), asyncHandler(async (req, res) => {
  const digits = last10Digits(req.body.phone);
  const me = await User.findById(req.user.id).select('phone').lean();
  if (me?.phone === digits) {
    throw validationError([{ path: 'phone', message: 'That is already your number' }]);
  }
  const data = await requestOtp({
    phone: digits, purpose: OTP_PURPOSE.PHONE_CHANGE, forUserId: req.user.id,
    ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.json({ ok: true, data });
}));

patientRoutes.post(
  '/me/phone/verify',
  validate({ body: z.object({ phone: z.string().min(10).max(14), otp: z.string().min(4).max(8) }) }),
  asyncHandler(async (req, res) => {
    const data = await confirmPhoneChange({ userId: req.user.id, phone: req.body.phone, otp: req.body.otp });
    res.json({ ok: true, data });
  }),
);

// ---- Delete account ----
// The typed word is the confirmation: deleting is permanent, and a stray tap
// or a scripted request must not be enough.
patientRoutes.delete(
  '/me',
  requireRole(ROLES.PATIENT),
  validate({ body: z.object({ confirm: z.literal('DELETE', { errorMap: () => ({ message: 'Type DELETE to confirm' }) }) }) }),
  asyncHandler(async (req, res) => {
    const data = await account.deleteAccount({ userId: req.user.id, actor: req.user, ip: req.ip });
    // The session ends with the account: clear the refresh cookie so the
    // browser does not keep trying to restore it.
    res.clearCookie('refreshToken', { path: '/' });
    res.json({ ok: true, data });
  }),
);

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
    // Turn the coordinates into something a human can verify on their profile.
    // Best-effort: if Maps is down or unkeyed, the coordinates still stand.
    let resolvedLabel = label ?? '';
    let formatted = '';
    if (!resolvedLabel) {
      const place = await reverseGeocode({ lat, lng });
      if (place) {
        resolvedLabel = place.locality || place.city || '';
        formatted = place.formatted ?? '';
      }
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          lastKnownLocation: {
            type: 'Point',
            coordinates: [lng, lat],
            label: resolvedLabel,
            formatted,
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
  const member = { ...req.body, linkedUserId: await accountFor(req.body.phone, req.user.id) };
  await User.updateOne({ _id: req.user.id }, { $push: { familyMembers: member } });
  const user = await User.findById(req.user.id).select('familyMembers').lean();
  res.status(201).json({ ok: true, data: user.familyMembers });
}));

patientRoutes.patch('/me/family/:memberId', validate(memberPatchSchema), asyncHandler(async (req, res) => {
  const patch = { ...req.body };
  // A changed number re-points the link at whoever owns the new one.
  if ('phone' in patch) patch.linkedUserId = await accountFor(patch.phone, req.user.id);
  const set = Object.fromEntries(
    Object.entries(patch).map(([k, v]) => [`familyMembers.$[m].${k}`, v]),
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
