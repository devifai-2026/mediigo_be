import argon2 from 'argon2';
import { User } from '../../models/User.js';
import { OtpVerification } from '../../models/OtpVerification.js';
import { Hospital } from '../../models/Hospital.js';
import { District } from '../../models/District.js';
import { OPDToken } from '../../models/OPDToken.js';
import { generateOtp, hashOtp, otpExpiryDate } from '../../lib/otp.js';
import { getMessagingProvider, getWaSettings } from '../../lib/providers/index.js';
import { last10Digits, isValidIndianMobile } from '../../lib/phone.js';
import { signAccessToken, signRefreshToken, verifyToken } from '../../lib/jwt.js';
import { randomUUID } from '../../lib/crypto.js';
import { logger, maskPhone } from '../../lib/logger.js';
import { validationError, unauthenticated, forbidden, conflict } from '../../lib/errors.js';
import { ROLES, OTP_PURPOSE, RESPONSE_CODES, TOKEN_STATUS } from '../../config/constants.js';
import { isDevelopment } from '../../config/env.js';

export const hashPassword = (plain) => argon2.hash(plain, { type: argon2.argon2id });

export const verifyPassword = async (hash, plain) => {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
};

const mintSession = async (user) => {
  const sessionId = randomUUID();
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user, sessionId),
    user: {
      id: String(user._id),
      name: user.name,
      phone: user.phone,
      email: user.email ?? null,
      photo: user.photo?.url ? { url: user.photo.url } : null,
      role: user.role,
      hospitalId: user.hospitalId ? String(user.hospitalId) : null,
      districtId: user.districtId ? String(user.districtId) : null,
      doctorId: user.doctorId ? String(user.doctorId) : null,
      familyMembers: user.familyMembers || [],
    },
  };
};

/**
 * Issue an OTP.
 *
 * Demo mode: the code is a fixed value and nothing is sent, BUT the hash of that
 * fixed code is still stored. That is the whole trick — the verify path below has
 * zero demo branching, and the moment demo mode is turned off, '1234' can never
 * verify again because the stored hash is of a random code.
 */
export const requestOtp = async ({ phone, purpose = OTP_PURPOSE.PATIENT_LOGIN, ip, userAgent, forUserId = null }) => {
  const digits = last10Digits(phone);
  if (!isValidIndianMobile(digits)) {
    throw validationError([{ path: 'phone', message: 'Enter a valid 10-digit mobile number' }]);
  }

  const { name: providerName, driver, settings } = await getMessagingProvider();
  const demo = settings.otpDemo;

  const user = await User.findOne({ phone: digits, isActive: true }).lean();
  if (purpose === OTP_PURPOSE.PHONE_CHANGE) {
    // The code goes to the NEW number, proving the caller holds it. That
    // number must not already sign someone else in.
    if (!forUserId) throw unauthenticated();
    if (user) throw conflict('This number is already registered to another Mediigo account', RESPONSE_CODES.CONFLICT);
  } else if (purpose !== OTP_PURPOSE.PATIENT_LOGIN && !user) {
    // Staff must already exist. Patients deliberately do not — a first-time
    // patient is created on verify, so login doubles as registration.
    throw unauthenticated('No active account found for this number');
  }

  const code = demo ? settings.otpDemoCode : generateOtp(settings.otpLength);

  // Invalidate prior pending OTPs by EXPIRING them — never by setting verifiedAt,
  // which would make "verifiedAt is not null" stop meaning "a human really logged
  // in" and corrupt every login metric derived from it.
  await OtpVerification.updateMany(
    { address: digits, purpose, verifiedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { expiresAt: new Date() } },
  );

  const record = await OtpVerification.create({
    userId: forUserId ?? user?._id ?? null,
    purpose,
    channel: demo ? 'demo' : providerName,
    address: digits,
    otpHash: hashOtp(code, digits),
    expiresAt: otpExpiryDate(settings.otpTtlMinutes),
    maxAttempts: settings.otpMaxAttempts,
    ip,
    userAgent,
  });

  if (!demo) {
    const { messageId } = await driver.sendTemplate({
      to: digits,
      templateId: settings.templateOtp,
      variables: ['OTP', code],
      settings,
    });
    if (messageId) {
      await OtpVerification.updateOne({ _id: record._id }, { $set: { providerMessageId: messageId } });
    }
  }

  logger.info({ address: maskPhone(digits), purpose, demo, provider: providerName }, 'OTP issued');

  return {
    sent: true,
    expiresInMinutes: settings.otpTtlMinutes,
    otpLength: demo ? settings.otpDemoCode.length : settings.otpLength,
    // Surfaced in development only, so the frontend can be exercised without a
    // phone. Never returned in production.
    ...(isDevelopment() && demo ? { debugCode: code } : {}),
  };
};

const upsertPatientOnFirstLogin = async (digits, name) => {
  const existing = await User.findOne({ phone: digits });
  if (existing) return existing;
  const created = await User.create({
    phone: digits,
    name: name || `Patient ${digits.slice(-4)}`,
    role: ROLES.PATIENT,
    familyMembers: [{ name: name || `Patient ${digits.slice(-4)}`, relation: 'SELF' }],
  });
  // Someone may already have added this person as a family member with this
  // number. Link those entries to the account that now exists.
  await User.updateMany(
    { 'familyMembers.phone': digits, _id: { $ne: created._id } },
    { $set: { 'familyMembers.$[m].linkedUserId': created._id } },
    { arrayFilters: [{ 'm.phone': digits }] },
  );
  return created;
};

/**
 * Claim an OTP: mark it used if the code is right, burn an attempt if not.
 * Shared by login and phone change, so both get the same attempt budget.
 */
const claimOtp = async ({ digits, purpose, otp }) => {
  const now = new Date();
  // Atomic claim: hash, expiry and attempt budget are all in the filter, so a
  // concurrent double-submit can only succeed once.
  const claimed = await OtpVerification.findOneAndUpdate(
    {
      address: digits,
      purpose,
      verifiedAt: null,
      expiresAt: { $gt: now },
      otpHash: hashOtp(otp, digits),
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
    },
    { $set: { verifiedAt: now } },
    { new: true, sort: { createdAt: -1 } },
  );

  if (!claimed) {
    // Burn an attempt on the newest live record. The sort matters: expired rows
    // share the address, and without it the increment could hit an old one.
    await OtpVerification.findOneAndUpdate(
      { address: digits, purpose, verifiedAt: null, expiresAt: { $gt: now } },
      { $inc: { attempts: 1 } },
      { sort: { createdAt: -1 } },
    );
    throw validationError([{ path: 'otp', message: 'Invalid or expired code' }], RESPONSE_CODES.OTP_INVALID);
  }

  return claimed;
};

/** Verify an OTP. Note there is no demo branch anywhere in here. */
export const verifyOtp = async ({ phone, purpose = OTP_PURPOSE.PATIENT_LOGIN, otp, name }) => {
  const digits = last10Digits(phone);
  const claimed = await claimOtp({ digits, purpose, otp });

  const user = claimed.userId
    ? await User.findById(claimed.userId)
    : await upsertPatientOnFirstLogin(digits, name);

  if (!user || !user.isActive) throw forbidden('This account has been deactivated');

  return mintSession(user);
};

/**
 * Staff password login. When the Super Admin has enabled 2FA for this role, the
 * password check succeeds but no session is minted — an OTP is issued and the
 * caller must complete verifyOtp with purpose STAFF_2FA.
 */
export const staffLogin = async ({ identifier, password, ip, userAgent }) => {
  const digits = last10Digits(identifier);
  const query = isValidIndianMobile(digits)
    ? { phone: digits }
    : { email: String(identifier || '').toLowerCase().trim() };

  const user = await User.findOne(query).select('+passwordHash');
  // Same message for unknown user and wrong password — distinguishing them tells
  // an attacker which phone numbers are registered staff.
  const invalid = unauthenticated('Invalid credentials');
  if (!user || user.role === ROLES.PATIENT) throw invalid;
  if (!(await verifyPassword(user.passwordHash, password))) throw invalid;
  if (!user.isActive) throw forbidden('This account has been deactivated');

  const settings = await getWaSettings();
  const needs2fa = (settings.require2faRoles || []).includes(user.role) || user.twoFactorEnabled;

  if (needs2fa) {
    await requestOtp({ phone: user.phone, purpose: OTP_PURPOSE.STAFF_2FA, ip, userAgent });
    return {
      requires2fa: true,
      phone: maskPhone(user.phone),
      purpose: OTP_PURPOSE.STAFF_2FA,
      expiresInMinutes: settings.otpTtlMinutes,
    };
  }

  return { requires2fa: false, ...(await mintSession(user)) };
};

export const refreshSession = async ({ refreshToken }) => {
  const claims = verifyToken(refreshToken);
  if (!claims || claims.type !== 'refresh') throw unauthenticated('Invalid refresh token');

  const user = await User.findById(claims.sub);
  if (!user || !user.isActive) throw forbidden('This account has been deactivated');

  // Rotate: a new refresh token each time, so a stolen one has a short life.
  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user, claims.sid || randomUUID()),
  };
};

export const getMe = async (userId) => {
  const user = await User.findById(userId).lean();
  // A deleted or deactivated account has no profile to return, even to an
  // access token minted before it was closed.
  if (!user || !user.isActive) throw unauthenticated();
  delete user.passwordHash;
  // The storage key is internal; the client only needs the URL.
  if (user.photo) delete user.photo.objectPath;

  /**
   * Clinic staff carry their clinic's trial state, so the portal can show how
   * long is left without a second round-trip on every page.
   *
   * Deliberately informational only. Nothing downstream gates on these fields:
   * an expired trial starts billing, it never closes the portal.
   */
  // District staff see their district in the header.
  if (user.districtId) {
    const district = await District.findById(user.districtId, { name: 1 }).lean();
    if (district) user.district = { id: String(district._id), name: district.name };
  }
  if (user.hospitalId) {
    const hospital = await Hospital.findById(user.hospitalId, { name: 1, trial: 1 }).lean();
    if (hospital) {
      const endsAt = hospital.trial?.endsAt ?? null;
      user.clinic = {
        id: String(hospital._id),
        name: hospital.name,
        trialEndsAt: endsAt,
        trialDaysLeft: endsAt ? Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86400000) : null,
        isBillable: endsAt ? new Date(endsAt).getTime() <= Date.now() : false,
      };
    }
  }
  return user;
};

/**
 * Move a patient to a new mobile number, once they have proved they hold it.
 *
 * The number is how they sign in, so it changes only through a code sent to
 * the new number. Waiting tokens take the new number too, so the desk calls
 * the phone the patient actually has; finished consultations keep the
 * number they were booked under, as the clinic's record.
 */
export const confirmPhoneChange = async ({ userId, phone, otp }) => {
  const digits = last10Digits(phone);
  const claimed = await claimOtp({ digits, purpose: OTP_PURPOSE.PHONE_CHANGE, otp });
  if (String(claimed.userId) !== String(userId)) throw forbidden('This code was issued for another account');
  // Re-checked here: the number could have signed up between request and verify.
  if (await User.exists({ phone: digits, _id: { $ne: userId } })) {
    throw conflict('This number is already registered to another Mediigo account', RESPONSE_CODES.CONFLICT);
  }
  await User.updateOne({ _id: userId }, { $set: { phone: digits } });
  await OPDToken.updateMany(
    { patientId: userId, status: { $in: [TOKEN_STATUS.WAITING] } },
    { $set: { 'patientSnapshot.phone': digits } },
  );
  // Anyone who added this person as family under the new number now links here.
  await User.updateMany(
    { 'familyMembers.phone': digits, _id: { $ne: userId } },
    { $set: { 'familyMembers.$[m].linkedUserId': userId } },
    { arrayFilters: [{ 'm.phone': digits }] },
  );
  return getMe(userId);
};
