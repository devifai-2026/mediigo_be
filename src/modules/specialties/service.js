import mongoose from 'mongoose';
import { Specialty, toSlug, Doctor } from '../../models/index.js';
import { assertUploadable, processAvatar, putObject, deleteObject } from '../../services/storage.js';
import { notFound, conflict, validationError } from '../../lib/errors.js';

/**
 * The specialty master.
 *
 * Patients see only active specialties, ordered for the browse grid. Admins see
 * every one, including hidden, because a hidden specialty still needs editing
 * and un-hiding.
 */

const shape = (s, counts) => ({
  id: String(s._id),
  name: s.name,
  slug: s.slug,
  tileLabel: s.tileLabel || s.name,
  description: s.description || '',
  photoUrl: s.photo?.url ?? null,
  order: s.order,
  isActive: s.isActive,
  // How many live doctors practise this. The number an admin needs before
  // hiding something: hiding a tile with 12 doctors behind it is a bigger
  // decision than hiding an empty one.
  doctorCount: counts?.get(String(s._id)) ?? 0,
  createdAt: s.createdAt,
});

/** Doctors per specialty, counted once rather than per row. */
const doctorCounts = async () => {
  const rows = await Doctor.aggregate([
    { $match: { isActive: true } },
    { $unwind: '$specialtyIds' },
    { $group: { _id: '$specialtyIds', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
};

export const listSpecialties = async ({ includeHidden = false } = {}) => {
  const filter = includeHidden ? {} : { isActive: true };
  const [rows, counts] = await Promise.all([
    Specialty.find(filter).sort({ order: 1, name: 1 }).lean(),
    doctorCounts(),
  ]);
  return rows.map((s) => shape(s, counts));
};

export const createSpecialty = async ({ body, actor }) => {
  const slug = toSlug(body.name);
  if (!slug) throw validationError([{ path: 'name', message: 'Name must contain at least one letter or number' }]);

  const clash = await Specialty.findOne({ slug }).lean();
  // A duplicate would split the same specialty across two tiles, each showing
  // half the doctors — worse than refusing to create it.
  if (clash) throw conflict(`"${clash.name}" already exists`);

  // Append by default so a new specialty never silently displaces an existing
  // tile's position in the grid.
  const last = await Specialty.findOne().sort({ order: -1 }).select('order').lean();
  const doc = await Specialty.create({
    name: body.name.trim(),
    slug,
    tileLabel: body.tileLabel?.trim() || '',
    description: body.description?.trim() || '',
    order: body.order ?? (last ? last.order + 10 : 10),
    isActive: body.isActive ?? true,
    createdBy: actor?.id ?? null,
  });
  return shape(doc.toObject(), await doctorCounts());
};

export const updateSpecialty = async ({ id, patch }) => {
  if (!mongoose.isValidObjectId(id)) throw notFound('Specialty not found');
  const doc = await Specialty.findById(id);
  if (!doc) throw notFound('Specialty not found');

  if (patch.name && patch.name.trim() !== doc.name) {
    const slug = toSlug(patch.name);
    if (!slug) throw validationError([{ path: 'name', message: 'Name must contain at least one letter or number' }]);
    const clash = await Specialty.findOne({ slug, _id: { $ne: doc._id } }).lean();
    if (clash) throw conflict(`"${clash.name}" already uses that name`);
    doc.name = patch.name.trim();
    doc.slug = slug;
  }
  if (patch.tileLabel !== undefined) doc.tileLabel = patch.tileLabel.trim();
  if (patch.description !== undefined) doc.description = patch.description.trim();
  if (patch.order !== undefined) doc.order = patch.order;
  if (patch.isActive !== undefined) doc.isActive = patch.isActive;

  await doc.save();
  return shape(doc.toObject(), await doctorCounts());
};

/**
 * Remove a specialty.
 *
 * Refused while doctors still practise it: deleting would leave them pointing
 * at nothing, and the admin almost always means "hide this" rather than "lose
 * the link for twelve doctors". The error says which to use instead.
 */
export const deleteSpecialty = async ({ id }) => {
  if (!mongoose.isValidObjectId(id)) throw notFound('Specialty not found');
  const doc = await Specialty.findById(id);
  if (!doc) throw notFound('Specialty not found');

  const inUse = await Doctor.countDocuments({ specialtyIds: doc._id, isActive: true });
  if (inUse > 0) {
    throw conflict(
      `${inUse} ${inUse === 1 ? 'doctor practises' : 'doctors practise'} ${doc.name}. Hide it instead of deleting.`,
    );
  }

  if (doc.photo?.objectPath) await deleteObject(doc.photo.objectPath);
  await Specialty.deleteOne({ _id: doc._id });
  return { deleted: true, id: String(doc._id) };
};

export const setSpecialtyPhoto = async ({ id, file }) => {
  if (!mongoose.isValidObjectId(id)) throw notFound('Specialty not found');
  const doc = await Specialty.findById(id);
  if (!doc) throw notFound('Specialty not found');

  assertUploadable(file);
  // Tiles are square in the grid, same as a doctor's avatar, so the same
  // processing applies — EXIF stripped, re-encoded, one predictable size.
  const processed = await processAvatar(file.buffer);
  const stored = await putObject({ ...processed, prefix: `specialties/${doc._id}` });

  const previous = doc.photo?.objectPath ?? null;
  doc.photo = { url: stored.url, objectPath: stored.objectPath, updatedAt: new Date() };
  await doc.save();
  // Only after the replacement is safely stored.
  if (previous && previous !== stored.objectPath) await deleteObject(previous);

  return shape(doc.toObject(), await doctorCounts());
};

export const removeSpecialtyPhoto = async ({ id }) => {
  if (!mongoose.isValidObjectId(id)) throw notFound('Specialty not found');
  const doc = await Specialty.findById(id);
  if (!doc) throw notFound('Specialty not found');

  const previous = doc.photo?.objectPath ?? null;
  doc.photo = { url: null, objectPath: null, updatedAt: new Date() };
  await doc.save();
  if (previous) await deleteObject(previous);
  return shape(doc.toObject(), await doctorCounts());
};

/**
 * Reorder in one call.
 *
 * Saving the whole order at once keeps the grid consistent: applying a drag as
 * a series of single updates leaves the list briefly in an order nobody chose,
 * which is visible if two admins are editing.
 */
export const reorderSpecialties = async ({ ids }) => {
  const valid = ids.filter((id) => mongoose.isValidObjectId(id));
  if (!valid.length) throw validationError([{ path: 'ids', message: 'No valid specialty ids given' }]);

  await Specialty.bulkWrite(
    valid.map((id, i) => ({
      updateOne: { filter: { _id: id }, update: { $set: { order: (i + 1) * 10 } } },
    })),
  );
  return listSpecialties({ includeHidden: true });
};
