/**
 * Seed the specialty master from the tiles the client used to hardcode, and
 * link existing doctors to it.
 *
 * Idempotent: run it after a deploy, or again later, without duplicating rows
 * or clobbering a photo an admin has since uploaded.
 *
 *   node scripts/seed-specialties.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import '../src/models/index.js';
import { Specialty, Doctor, toSlug } from '../src/models/index.js';

// Exactly the nine tiles the Explore grid shipped with, in the same order and
// with the same images, so the page looks unchanged on the day this lands.
// "All Clinics" is NOT here: it is the absence of a filter, not a specialty,
// and storing it would let an admin hide the tile that clears the filter.
const TILES = [
  { name: 'General Medicine', tileLabel: 'General\nMedicine', img: '/categories/GeneralMedicine.png' },
  { name: 'Pediatrics', img: '/categories/Pediatrics.png' },
  { name: 'Cardiology', img: '/categories/Group%2023.png' },
  { name: 'Orthopedics', img: '/categories/Orthopedics.png' },
  { name: 'Dermatology', img: '/categories/Dermatology.png' },
  { name: 'ENT', tileLabel: 'Ear\nThroat\nNose', img: '/categories/EarThroatNose.png' },
  { name: 'Gynecology', tileLabel: 'Gynaecology', img: '/categories/Gynaecology.png' },
  { name: 'Dentistry', img: '/categories/Dentistry.png' },
];

const run = async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  console.log(`connected to ${env.MONGODB_DB_NAME}`);

  let created = 0;
  let kept = 0;
  for (const [i, tile] of TILES.entries()) {
    const slug = toSlug(tile.name);
    const existing = await Specialty.findOne({ slug });
    if (existing) {
      kept += 1;
      continue;
    }
    await Specialty.create({
      name: tile.name,
      slug,
      tileLabel: tile.tileLabel || '',
      order: (i + 1) * 10,
      isActive: true,
      // The bundled artwork, so tiles are not blank before anyone uploads.
      // An admin replacing one writes a real object-storage URL over this.
      photo: { url: tile.img, objectPath: null, updatedAt: null },
    });
    created += 1;
  }
  console.log(`specialties: ${created} created, ${kept} already present`);

  // Link every doctor to the specialty their free-text string names. Without
  // this the tiles would exist but match nobody, since specialtyIds is new and
  // therefore empty on all 24 existing doctors.
  const all = await Specialty.find().select('name slug').lean();
  const bySlug = new Map(all.map((s) => [s.slug, s._id]));

  const doctors = await Doctor.find().select('name specialty specialtyIds').lean();
  let linked = 0;
  let unmatched = [];
  for (const d of doctors) {
    const id = bySlug.get(toSlug(d.specialty));
    if (!id) {
      unmatched.push(`${d.name} (${d.specialty})`);
      continue;
    }
    // Skip anyone already linked, so re-running never duplicates the reference.
    if ((d.specialtyIds || []).some((x) => String(x) === String(id))) continue;
    await Doctor.updateOne({ _id: d._id }, { $addToSet: { specialtyIds: id } });
    linked += 1;
  }
  console.log(`doctors: ${linked} linked, ${doctors.length - linked} already linked or unmatched`);

  if (unmatched.length) {
    // Loud rather than silent: a doctor whose specialty has no tile is
    // invisible to the browse grid, and that is a data problem to fix, not a
    // detail to swallow.
    console.warn(`\n${unmatched.length} doctor(s) have a specialty with no matching tile:`);
    unmatched.forEach((u) => console.warn(`  - ${u}`));
    console.warn('Create those specialties in Super Admin, then re-run this script.');
  }

  const summary = await Specialty.find().sort({ order: 1 }).select('name order isActive').lean();
  console.log('\nfinal order:');
  summary.forEach((s) => console.log(`  ${String(s.order).padStart(3)}  ${s.name}${s.isActive ? '' : '  (hidden)'}`));

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
