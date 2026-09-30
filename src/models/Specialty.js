import mongoose from 'mongoose';

/**
 * A medical specialty, as the network presents it to patients.
 *
 * Specialties were free text on Doctor, which meant "Pediatrics" and
 * "Paediatrics" were different filters, the browse tiles were hardcoded in the
 * client, and nobody could add one without a deploy. This makes them a managed
 * list: an admin controls the label, the photo, the order the tiles appear in,
 * and whether a tile is shown at all.
 *
 * `slug` is the stable identity. The display name can be corrected — a typo, a
 * rename from "ENT" to "Ear, Throat & Nose" — without breaking anything that
 * already points here.
 */
const specialtySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },

    // Free text, so an admin can say "Ear\nThroat\nNose" and have it wrap the
    // way the tile design expects without that leaking into the real name.
    tileLabel: { type: String, default: '' },
    description: { type: String, default: '' },

    photo: {
      url: { type: String, default: null },
      objectPath: { type: String, default: null },
      updatedAt: { type: Date, default: null },
    },

    // Where the tile sits in the grid. Sparse integers so one can be moved
    // between two others without renumbering the rest.
    order: { type: Number, default: 100 },

    /**
     * Hidden tiles stay in the data and keep their doctors — this only controls
     * whether patients see the tile. Deleting a specialty that doctors still
     * practise would orphan them, which is why hiding exists at all.
     */
    isActive: { type: Boolean, default: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

specialtySchema.index({ slug: 1 }, { unique: true });
specialtySchema.index({ isActive: 1, order: 1 });

/** "Ear, Throat & Nose" -> "ear-throat-nose". */
export const toSlug = (name) =>
  String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const Specialty = mongoose.model('Specialty', specialtySchema);
