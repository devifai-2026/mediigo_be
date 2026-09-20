import mongoose from 'mongoose';
import { User, Hospital, Doctor, OnboardingSubmission, AuditLog, District } from '../../models/index.js';
import { hashPassword } from '../auth/service.js';
import { requestOtp } from '../auth/service.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { notFound, conflict, validationError, forbidden } from '../../lib/errors.js';
import { randomToken } from '../../lib/crypto.js';
import { last10Digits, isValidIndianMobile } from '../../lib/phone.js';
import { ROLES, OTP_PURPOSE, AUDIT_ACTIONS, RESPONSE_CODES } from '../../config/constants.js';

const MANAGED = [ROLES.EXEC_ADMIN, ROLES.FIELD_AGENT, ROLES.RECEPTIONIST, ROLES.SUPER_ADMIN];

const assertManaged = (user) => {
  if (!user) throw notFound('User not found');
  if (!MANAGED.includes(user.role)) {
    // Doctors are managed through the clinic lifecycle, not here — deactivating
    // one has to also close their session and release today's queue.
    throw conflict(`${user.role} accounts are managed from the clinic directory, not staff administration`);
  }
  return user;
};

/** What a district loses if its admin leaves — shown before you confirm. */
export const districtLoad = async (districtId) => {
  if (!districtId) return { hospitals: 0, doctors: 0, agents: 0, pendingSubmissions: 0 };
  const hospitals = await Hospital.find({ districtId }).select('_id').lean();
  const ids = hospitals.map((h) => h._id);
  const [doctors, agents, pendingSubmissions] = await Promise.all([
    Doctor.countDocuments({ hospitalId: { $in: ids }, isActive: true }),
    User.countDocuments({ districtId, role: ROLES.FIELD_AGENT, isActive: true }),
    OnboardingSubmission.countDocuments({ districtId, status: { $in: ['SUBMITTED', 'UNDER_REVIEW'] } }),
  ]);
  return { hospitals: hospitals.length, doctors, agents, pendingSubmissions };
};

export const listStaff = async ({ role, includeInactive = true }) => {
  const filter = { role: role ? role : { $in: MANAGED } };
  if (!includeInactive) filter.isActive = true;

  const users = await User.find(filter)
    .populate('districtId', 'name code')
    .populate('hospitalId', 'name code')
    .sort({ role: 1, name: 1 })
    .lean();

  // Attach each person's workload so the table can warn before you remove them.
  return Promise.all(users.map(async (u) => {
    const base = {
      id: String(u._id),
      name: u.name,
      phone: u.phone,
      email: u.email ?? null,
      role: u.role,
      isActive: u.isActive,
      districtId: u.districtId ? String(u.districtId._id) : null,
      districtName: u.districtId?.name ?? null,
      hospitalName: u.hospitalId?.name ?? null,
      lastLoginAt: u.lastLoginAt ?? null,
      createdAt: u.createdAt,
    };
    if (u.role === ROLES.EXEC_ADMIN) base.load = await districtLoad(u.districtId?._id);
    if (u.role === ROLES.FIELD_AGENT) {
      base.load = {
        submissions: await OnboardingSubmission.countDocuments({ agentId: u._id }),
        pendingSubmissions: await OnboardingSubmission.countDocuments({
          agentId: u._id, status: { $in: ['SUBMITTED', 'UNDER_REVIEW'] },
        }),
      };
    }
    return base;
  }));
};

export const createStaff = async ({ body, actor, ip, userAgent }) => {
  const phone = last10Digits(body.phone);
  if (!isValidIndianMobile(phone)) {
    throw validationError([{ path: 'phone', message: 'Enter a valid 10-digit mobile number' }]);
  }
  const clash = await User.findOne({ phone }).lean();
  if (clash) throw conflict(`${clash.name} already uses this number`);

  // A Field Agent works a territory, so they need one from day one. An Exec
  // Admin may start unassigned: you often need to create the successor BEFORE
  // you can hand a district over, and requiring one here would deadlock that.
  if (body.role === ROLES.FIELD_AGENT && !body.districtId) {
    throw validationError([{ path: 'districtId', message: 'A field agent must be assigned to a district' }]);
  }
  // One district, one admin — otherwise "who approves this?" has two answers.
  if (body.role === ROLES.EXEC_ADMIN) {
    const existing = await User.findOne({ role: ROLES.EXEC_ADMIN, districtId: body.districtId, isActive: true }).lean();
    if (existing) {
      throw conflict(`${existing.name} already administers this district — transfer it first`);
    }
  }

  const password = body.password || randomToken(6);
  const user = await User.create({
    name: body.name.trim(),
    phone,
    email: body.email || null,
    role: body.role,
    districtId: body.districtId || null,
    hospitalId: body.hospitalId || null,
    passwordHash: await hashPassword(password),
    createdBy: actor.id,
  });

  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.USER_CREATED,
    entityType: 'User', entityId: user._id, districtId: body.districtId || null, ip, userAgent,
    after: { name: user.name, role: user.role, phone },
  });

  // Returned once so it can be handed over; never stored in readable form.
  return { user: user.toSafeJSON(), temporaryPassword: body.password ? null : password };
};

export const updateStaff = async ({ userId, patch, actor, ip, userAgent }) => {
  const user = assertManaged(await User.findById(userId));
  const before = { name: user.name, phone: user.phone, email: user.email, districtId: user.districtId };
  const set = {};

  if (patch.name) set.name = patch.name.trim();
  if (patch.email !== undefined) set.email = patch.email || null;

  if (patch.phone) {
    const phone = last10Digits(patch.phone);
    if (!isValidIndianMobile(phone)) {
      throw validationError([{ path: 'phone', message: 'Enter a valid 10-digit mobile number' }]);
    }
    if (phone !== user.phone) {
      const clash = await User.findOne({ phone, _id: { $ne: user._id } }).lean();
      if (clash) throw conflict(`${clash.name} already uses this number`);
      set.phone = phone;
    }
  }

  if (patch.districtId !== undefined && String(patch.districtId) !== String(user.districtId ?? '')) {
    if (user.role === ROLES.EXEC_ADMIN && patch.districtId) {
      const existing = await User.findOne({
        role: ROLES.EXEC_ADMIN, districtId: patch.districtId, isActive: true, _id: { $ne: user._id },
      }).lean();
      if (existing) throw conflict(`${existing.name} already administers that district`);
    }
    set.districtId = patch.districtId || null;
  }

  if (!Object.keys(set).length) return { user: user.toSafeJSON(), changed: false };

  await User.updateOne({ _id: user._id }, { $set: set });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: 'USER_UPDATED',
    entityType: 'User', entityId: user._id, ip, userAgent,
    before, after: set,
  });
  return { user: (await User.findById(user._id)).toSafeJSON(), changed: true };
};

/** Set a temporary password. Returned once, then only its hash exists. */
export const resetPassword = async ({ userId, password, actor, ip, userAgent }) => {
  const user = assertManaged(await User.findById(userId));
  const next = password || randomToken(6);
  if (next.length < 8) {
    throw validationError([{ path: 'password', message: 'Password must be at least 8 characters' }]);
  }
  await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(next) } });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: 'USER_PASSWORD_RESET',
    entityType: 'User', entityId: user._id, ip, userAgent, after: { by: 'temporary password' },
  });
  return { temporaryPassword: next };
};

/** Send a WhatsApp reset code instead, so the password never passes through you. */
export const sendPasswordResetOtp = async ({ userId, actor, ip, userAgent }) => {
  const user = assertManaged(await User.findById(userId));
  await requestOtp({ phone: user.phone, purpose: OTP_PURPOSE.STAFF_LOGIN, ip, userAgent });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: 'USER_PASSWORD_RESET',
    entityType: 'User', entityId: user._id, ip, userAgent, after: { by: 'whatsapp code' },
  });
  return { sent: true, phone: `******${user.phone.slice(-4)}` };
};

/**
 * Hand a district to another admin. Clinics and agents belong to the district,
 * so moving the district moves everything under it in one write — nothing is
 * left without an owner.
 */
export const transferDistrict = async ({ districtId, toUserId, actor, ip, userAgent }) => {
  const district = await District.findById(districtId).lean();
  if (!district) throw notFound('District not found');

  const to = await User.findById(toUserId);
  if (!to || to.role !== ROLES.EXEC_ADMIN) throw validationError([{ path: 'toUserId', message: 'Pick an Executive Admin' }]);
  if (!to.isActive) throw conflict('That admin is deactivated — reactivate them first');

  const from = await User.findOne({ role: ROLES.EXEC_ADMIN, districtId, isActive: true });
  const load = await districtLoad(districtId);

  // An admin holds exactly one district (User.districtId is singular). Moving a
  // district onto someone who already has one would silently orphan theirs, so
  // refuse and say whose clinics would have been left without an owner.
  if (to.districtId && String(to.districtId) !== String(districtId)) {
    const theirs = await District.findById(to.districtId).lean();
    const theirLoad = await districtLoad(to.districtId);
    throw conflict(
      `${to.name} already administers ${theirs?.name ?? 'another district'} (${theirLoad.hospitals} clinic${theirLoad.hospitals === 1 ? '' : 's'}) — taking this one would leave those without an owner. Pick an admin with no district, or create one.`,
      RESPONSE_CODES.CONFLICT,
      { blockedBy: 'RECIPIENT_HAS_DISTRICT', recipientDistrict: theirs?.name ?? null, recipientLoad: theirLoad },
    );
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (from && String(from._id) !== String(to._id)) {
        await User.updateOne({ _id: from._id }, { $set: { districtId: null } }, { session });
      }
      await User.updateOne({ _id: to._id }, { $set: { districtId: district._id } }, { session });
    });
  } finally {
    await session.endSession();
  }

  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: 'DISTRICT_TRANSFERRED',
    entityType: 'District', entityId: district._id, districtId: district._id, ip, userAgent,
    before: { admin: from?.name ?? null }, after: { admin: to.name, load },
  });

  return { district: district.name, from: from?.name ?? null, to: to.name, load };
};

/**
 * Deactivate. Reversible, and the record stays so audit rows and onboarded
 * clinics keep naming a real person. An Exec Admin must hand over their
 * district first, or their clinics lose their owner.
 */
export const deactivateStaff = async ({ userId, reason, transferToUserId, actor, ip, userAgent }) => {
  const user = assertManaged(await User.findById(userId));
  if (String(user._id) === String(actor.id)) throw conflict('You cannot deactivate your own account');
  if (!user.isActive) throw conflict('This account is already deactivated');

  if (user.role === ROLES.SUPER_ADMIN) {
    const others = await User.countDocuments({ role: ROLES.SUPER_ADMIN, isActive: true, _id: { $ne: user._id } });
    if (others === 0) throw conflict('This is the last active Super Admin — create another before deactivating this one');
  }

  if (user.role === ROLES.EXEC_ADMIN && user.districtId) {
    const load = await districtLoad(user.districtId);
    if (load.hospitals > 0 && !transferToUserId) {
      throw conflict(
        `${user.name} administers a district with ${load.hospitals} clinic${load.hospitals === 1 ? '' : 's'} — hand it over first`,
        RESPONSE_CODES.CONFLICT,
        { requiresTransfer: true, districtId: String(user.districtId), load },
      );
    }
    if (transferToUserId) {
      await transferDistrict({ districtId: user.districtId, toUserId: transferToUserId, actor, ip, userAgent });
    }
  }

  await User.updateOne({ _id: user._id }, { $set: { isActive: false, districtId: null } });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.USER_DEACTIVATED,
    entityType: 'User', entityId: user._id, reason, ip, userAgent,
    before: { isActive: true, role: user.role },
  });
  return { deactivated: true, name: user.name };
};

export const reactivateStaff = async ({ userId, districtId, actor, ip, userAgent }) => {
  const user = assertManaged(await User.findById(userId));
  if (user.isActive) throw conflict('This account is already active');

  if (user.role === ROLES.EXEC_ADMIN && districtId) {
    const existing = await User.findOne({ role: ROLES.EXEC_ADMIN, districtId, isActive: true }).lean();
    if (existing) throw conflict(`${existing.name} already administers that district`);
  }

  await User.updateOne({ _id: user._id }, { $set: { isActive: true, ...(districtId ? { districtId } : {}) } });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: 'USER_REACTIVATED',
    entityType: 'User', entityId: user._id, ip, userAgent,
  });
  return { reactivated: true, name: user.name };
};

/**
 * Hard delete. Only for accounts created in error — anyone who has actually
 * done work is refused, because audit rows and submissions reference them by
 * id and would be left pointing at nothing.
 */
export const deleteStaff = async ({ userId, actor, ip, userAgent }) => {
  const user = assertManaged(await User.findById(userId));
  if (String(user._id) === String(actor.id)) throw conflict('You cannot delete your own account');
  if (user.isActive) throw conflict('Deactivate the account before deleting it');

  const [submissions, approvals, auditRows, hospitals] = await Promise.all([
    OnboardingSubmission.countDocuments({ agentId: user._id }),
    Hospital.countDocuments({ $or: [{ approvedBy: user._id }, { onboardedBy: user._id }] }),
    AuditLog.countDocuments({ actorId: user._id }),
    Hospital.countDocuments({ districtId: user.districtId ?? null }),
  ]);

  const history = submissions + approvals + auditRows;
  if (history > 0) {
    throw conflict(
      `${user.name} has ${history} historical record${history === 1 ? '' : 's'} on the platform and cannot be deleted — keep the account deactivated so the audit trail stays intact`,
      RESPONSE_CODES.CONFLICT,
      { submissions, approvals, auditRows, hospitals },
    );
  }

  await User.deleteOne({ _id: user._id });
  writeAuditLog({
    actorId: actor.id, actorRole: actor.role, action: 'USER_DELETED',
    entityType: 'User', entityId: user._id, ip, userAgent,
    before: { name: user.name, role: user.role, phone: user.phone },
  });
  return { deleted: true, name: user.name };
};
