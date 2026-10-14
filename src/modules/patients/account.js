import { User, OPDToken, Review, PatientPolicy } from '../../models/index.js';
import { assertUploadable, processAvatar, putObject, deleteObject } from '../../services/storage.js';
import { cancelToken } from '../queue/service.js';
import { conflict, notFound } from '../../lib/errors.js';
import { writeAuditLogAwaited } from '../../lib/auditLog.js';
import { ROLES, TOKEN_STATUS, RESPONSE_CODES, AUDIT_ACTIONS } from '../../config/constants.js';

/**
 * A patient's own account: their photo, and closing the account.
 */

/**
 * Staff can sign in by email, and that lookup takes the first user with the
 * address. A patient saving a staff member's email would shadow their login,
 * so an address may belong to one account only.
 */
export const assertEmailFree = async (email, userId) => {
  if (!email) return;
  if (await User.exists({ email: email.toLowerCase().trim(), _id: { $ne: userId } })) {
    throw conflict('This email is already used by another account', RESPONSE_CODES.CONFLICT);
  }
};

/**
 * Replace the profile photo. The old object is deleted only after the new one
 * is stored, so a failed upload never leaves the patient with no photo.
 */
export const setPhoto = async ({ userId, file }) => {
  assertUploadable(file);
  const processed = await processAvatar(file.buffer);
  const stored = await putObject({ ...processed, prefix: `patients/${userId}` });
  const before = await User.findById(userId).select('photo').lean();
  await User.updateOne(
    { _id: userId },
    { $set: { photo: { url: stored.url, objectPath: stored.objectPath, updatedAt: new Date() } } },
  );
  if (before?.photo?.objectPath) await deleteObject(before.photo.objectPath);
  return { url: stored.url };
};

export const removePhoto = async ({ userId }) => {
  const before = await User.findById(userId).select('photo').lean();
  await User.updateOne({ _id: userId }, { $set: { photo: { url: null, objectPath: null, updatedAt: new Date() } } });
  if (before?.photo?.objectPath) await deleteObject(before.photo.objectPath);
  return { url: null };
};

/**
 * Delete a patient's account, from inside the app, with no support ticket.
 *
 * What goes: everything that identifies them on their profile — name, phone,
 * email, photo, date of birth, Aadhaar link, saved location and family
 * members — and every upcoming booking, cancelled so the clinic sees the slot
 * free up. Their mobile number is released, so signing in with it again
 * starts a brand-new, empty account.
 *
 * What stays: consultations that already happened. Those are the clinic's
 * medical and billing records, which clinics are required to keep, so they
 * remain with the clinic rather than with this account. Reviews stay public
 * but are anonymised.
 *
 * The record itself is kept as an inactive tombstone rather than removed, so
 * the retained consultations still point at something and every live session
 * fails its next active-user check.
 */
export const deleteAccount = async ({ userId, actor, ip }) => {
  const user = await User.findById(userId).lean();
  if (!user || user.role !== ROLES.PATIENT) throw notFound('Account not found');

  if (await OPDToken.exists({ patientId: userId, status: TOKEN_STATUS.IN_CHAMBER })) {
    throw conflict('You are with the doctor right now — you can delete your account once the consultation ends.');
  }

  // Through the normal cancel path, so the queue, the doctor's alert and the
  // live boards all update exactly as if the patient had cancelled each one.
  const upcoming = await OPDToken.find({ patientId: userId, status: TOKEN_STATUS.WAITING }).select('_id').lean();
  for (const t of upcoming) {
    // eslint-disable-next-line no-await-in-loop
    await cancelToken({ tokenId: t._id, actor, reason: 'Patient deleted their account' });
  }

  if (user.photo?.objectPath) await deleteObject(user.photo.objectPath);

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        name: 'Deleted user',
        // phone is unique and required; a placeholder frees the real number.
        phone: `deleted-${userId}`,
        email: null,
        aadhaarHash: null,
        familyMembers: [],
        photo: { url: null, objectPath: null, updatedAt: new Date() },
        isActive: false,
        deletedAt: new Date(),
      },
      $unset: { dob: '', gender: '', lastKnownLocation: '' },
    },
  );

  // Nobody's family list should keep pointing at an account that is gone.
  await User.updateMany(
    { 'familyMembers.linkedUserId': userId },
    { $set: { 'familyMembers.$[m].linkedUserId': null } },
    { arrayFilters: [{ 'm.linkedUserId': userId }] },
  );
  await Review.updateMany({ patientId: userId }, { $set: { patientName: 'Former patient' } });
  // Policies an agent captured belong to the person, not this login; unlink
  // them so they can be re-linked if this person signs up again.
  await PatientPolicy.updateMany({ patientId: userId }, { $set: { patientId: null } });

  await writeAuditLogAwaited({
    actorId: userId,
    actorRole: ROLES.PATIENT,
    action: AUDIT_ACTIONS.PATIENT_ACCOUNT_DELETED,
    entityType: 'User',
    entityId: userId,
    after: { cancelledBookings: upcoming.length },
    ip,
  });

  return { cancelledBookings: upcoming.length };
};
