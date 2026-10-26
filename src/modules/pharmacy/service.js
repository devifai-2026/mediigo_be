import { Prescription, User, Doctor } from '../../models/index.js';
import { hashPassword } from '../auth/service.js';
import { clinicHasPharmacy } from '../prescriptions/service.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { randomToken } from '../../lib/crypto.js';
import { last10Digits, isValidIndianMobile } from '../../lib/phone.js';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors.js';
import { emitPharmacyRx } from '../../realtime/emitters.js';
import { AUDIT_ACTIONS, PHARMACY_STATUS, ROLES } from '../../config/constants.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- the pharmacy's queue --------------------------------------------------

const VIEW = {
  PENDING: { 'pharmacy.status': PHARMACY_STATUS.PENDING },
  DONE: { 'pharmacy.status': { $in: [PHARMACY_STATUS.DISPENSED, PHARMACY_STATUS.PARTIAL] } },
  ALL: { pharmacy: { $ne: null } },
};

/**
 * Prescriptions sent to this clinic's pharmacy, newest first. Pending ones are
 * the working queue; the rest are history, searchable by patient name or phone.
 */
export const listPharmacyQueue = async ({ query, actor }) => {
  const scope = { hospitalId: actor.hospitalId };
  const filter = { ...scope, ...VIEW[query.view || 'PENDING'] };
  if (query.date) filter.date = query.date;
  const q = query.q?.trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    filter.$or = [
      { 'patientSnapshot.name': { $regex: escapeRe(q), $options: 'i' } },
      ...(digits.length >= 4 ? [{ 'patientSnapshot.phone': { $regex: escapeRe(digits) } }] : []),
    ];
  }
  const [items, pending] = await Promise.all([
    Prescription.find(filter).sort({ 'pharmacy.sentAt': -1 }).limit(query.limit || 100).lean(),
    Prescription.countDocuments({ ...scope, ...VIEW.PENDING }),
  ]);
  return { items, pending };
};

/**
 * Record what the pharmacy gave. PARTIAL names the medicines it could not, so
 * the doctor can see the patient is buying those elsewhere. PENDING undoes a
 * mistaken tap.
 */
export const dispense = async ({ id, body, actor }) => {
  const rx = await Prescription.findById(id).catch(() => null);
  if (!rx || !sameId(rx.hospitalId, actor.hospitalId)) throw notFound('Prescription not found');
  if (!rx.pharmacy) throw conflict('This prescription was not sent to the pharmacy');

  const names = new Set(rx.medicines.map((m) => m.name));
  const unavailable = body.status === PHARMACY_STATUS.PARTIAL ? [...new Set(body.unavailable)] : [];
  if (body.status === PHARMACY_STATUS.PARTIAL) {
    if (!unavailable.length) throw validationError([{ path: 'unavailable', message: 'Pick the medicines that were not given' }]);
    if (unavailable.some((n) => !names.has(n))) throw validationError([{ path: 'unavailable', message: 'Unknown medicine on this prescription' }]);
    if (unavailable.length === names.size) {
      throw validationError([{ path: 'unavailable', message: 'Nothing was given — leave it pending instead' }]);
    }
  }

  const done = body.status !== PHARMACY_STATUS.PENDING;
  const me = done ? await User.findById(actor.id).select('name').lean() : null;
  rx.pharmacy = {
    ...rx.pharmacy.toObject(),
    status: body.status,
    unavailable,
    note: body.note?.trim() || '',
    dispensedAt: done ? new Date() : null,
    dispensedBy: done ? actor.id : null,
    dispensedByName: me?.name ?? '',
  };
  await rx.save();
  const out = rx.toObject();

  writeAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRESCRIPTION_DISPENSED,
    entityType: 'Prescription',
    entityId: rx._id,
    hospitalId: rx.hospitalId,
    after: { status: body.status, unavailable: unavailable.length },
  });
  emitPharmacyRx(out);
  return out;
};

export const pharmacyStatus = async ({ actor }) => ({ hasPharmacy: await clinicHasPharmacy(actor.hospitalId) });

// ---- pharmacist logins, managed by the clinic -------------------------------

/**
 * Who at a clinic may add or remove its pharmacy logins: the clinic-admin
 * doctor. A clinic with no doctor marked admin — usually a one-doctor practice —
 * lets any of its doctors do it, rather than leaving nobody able to.
 */
const canManage = async (actor) => {
  if (actor.role === ROLES.SUPER_ADMIN) return true;
  if (actor.role !== ROLES.DOCTOR || !actor.hospitalId) return false;
  const me = await Doctor.findById(actor.doctorId).select('isClinicAdmin').lean();
  if (me?.isClinicAdmin) return true;
  return !(await Doctor.exists({ hospitalId: actor.hospitalId, isClinicAdmin: true, isActive: true }));
};

const assertCanManage = async (actor) => {
  if (!(await canManage(actor))) throw forbidden('Only the clinic admin can manage pharmacy logins');
};

const staffRow = (u) => ({
  id: String(u._id),
  name: u.name,
  phone: u.phone,
  email: u.email ?? null,
  isActive: u.isActive,
  lastLoginAt: u.lastLoginAt ?? null,
  createdAt: u.createdAt,
});

export const listPharmacists = async ({ actor }) => {
  const users = await User.find({ hospitalId: actor.hospitalId, role: ROLES.PHARMACIST })
    .sort({ isActive: -1, name: 1 }).lean();
  return { canManage: await canManage(actor), pharmacists: users.map(staffRow) };
};

export const createPharmacist = async ({ body, actor, ip, userAgent }) => {
  await assertCanManage(actor);
  const phone = last10Digits(body.phone);
  if (!isValidIndianMobile(phone)) throw validationError([{ path: 'phone', message: 'Enter a valid 10-digit mobile number' }]);
  // One number, one login — a patient account on this number would otherwise
  // be shadowed by the staff one.
  const clash = await User.findOne({ phone }).lean();
  if (clash) throw conflict(`${clash.name} already uses this number on Mediigo`);

  const password = randomToken(6);
  const user = await User.create({
    name: body.name.trim(),
    phone,
    email: body.email || null,
    role: ROLES.PHARMACIST,
    hospitalId: actor.hospitalId,
    passwordHash: await hashPassword(password),
    createdBy: actor.id,
  });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.USER_CREATED,
    entityType: 'User', entityId: user._id, hospitalId: actor.hospitalId, ip, userAgent,
    after: { name: user.name, role: user.role, phone },
  });
  // Returned once so it can be handed over; never stored in readable form.
  return { pharmacist: staffRow(user), temporaryPassword: password };
};

const ownPharmacist = async (id, actor) => {
  const user = await User.findById(id).catch(() => null);
  if (!user || user.role !== ROLES.PHARMACIST || !sameId(user.hospitalId, actor.hospitalId)) throw notFound('Pharmacist not found');
  return user;
};

export const setPharmacistActive = async ({ id, isActive, actor, ip, userAgent }) => {
  await assertCanManage(actor);
  const user = await ownPharmacist(id, actor);
  user.isActive = isActive;
  await user.save();
  if (!isActive) {
    writeAuditLog({
      actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.USER_DEACTIVATED,
      entityType: 'User', entityId: user._id, hospitalId: actor.hospitalId, ip, userAgent,
    });
  }
  return staffRow(user);
};

export const resetPharmacistPassword = async ({ id, actor }) => {
  await assertCanManage(actor);
  const user = await ownPharmacist(id, actor);
  const password = randomToken(6);
  user.passwordHash = await hashPassword(password);
  await user.save();
  return { pharmacist: staffRow(user), temporaryPassword: password };
};
