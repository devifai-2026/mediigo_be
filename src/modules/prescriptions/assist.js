import mongoose from 'mongoose';
import { Prescription } from '../../models/index.js';
import { FORMULARY } from './formulary.js';

/**
 * Typing aids for the prescription pad.
 *
 * A doctor writes the same few dozen medicines all day, each the same way, so
 * their own history is the best predictor of what comes next. It ranks first
 * and carries their usual dose, course and timing; the formulary fills in
 * whatever they have not written here before.
 */

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.%/+]+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every query word must start some word of the text: "pan 40" finds "Tab Pan 40",
// "para 650" finds "Paracetamol 650mg".
const matchesAll = (qWords, text) => {
  const tWords = words(text);
  return qWords.every((q) => tWords.some((t) => t.startsWith(q)));
};

const FORMULARY_INDEX = FORMULARY.map((m) => ({ ...m, key: norm(m.name), nameWords: words(m.name) }));

const rankFormulary = (q) => {
  const qWords = words(q);
  if (!qWords.length) return [];
  const qn = norm(q);
  return FORMULARY_INDEX
    .map((m) => {
      if (matchesAll(qWords, m.name)) {
        // The brand word itself ("Dolo"), ignoring the "Tab"/"Syr" form prefix.
        const brand = m.nameWords[1] ?? m.nameWords[0];
        const score = brand.startsWith(qWords[0]) || m.key.startsWith(qn) ? 0 : 1;
        return { m, score };
      }
      if (matchesAll(qWords, m.generic)) return { m, score: 2 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || a.m.name.length - b.m.name.length)
    .map(({ m }) => m);
};

/** The doctor's own medicines, most-written first, each as they last wrote it. */
const doctorMedicines = async (doctorId, q, limit) => {
  if (!doctorId) return [];
  const qWords = words(q);
  const nameMatch = qWords.length
    ? { $and: qWords.map((w) => ({ 'medicines.name': { $regex: `(^|[^a-z0-9])${escapeRe(w)}`, $options: 'i' } })) }
    : {};
  const rows = await Prescription.aggregate([
    { $match: { doctorId: new mongoose.Types.ObjectId(String(doctorId)) } },
    { $sort: { createdAt: -1 } },
    { $limit: 500 },
    { $unwind: '$medicines' },
    { $match: nameMatch },
    {
      $group: {
        _id: { $toLower: '$medicines.name' },
        name: { $first: '$medicines.name' },
        dosage: { $first: '$medicines.dosage' },
        duration: { $first: '$medicines.duration' },
        instruction: { $first: '$medicines.instruction' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, name: 1 } },
    { $limit: limit },
  ]);
  return rows.map(({ _id, ...r }) => r);
};

export const suggestMedicines = async ({ q = '', doctorId }) => {
  const mine = await doctorMedicines(doctorId, q, q ? 5 : 10);
  const seen = new Set(mine.map((m) => norm(m.name)));
  const generics = new Map(FORMULARY_INDEX.map((m) => [m.key, m.generic]));
  const fromFormulary = rankFormulary(q)
    .filter((m) => !seen.has(m.key))
    .slice(0, 10 - Math.min(mine.length, 4))
    .map(({ name, generic, dosage, duration, instruction }) => ({ name, generic, dosage, duration, instruction, source: 'formulary' }));
  return [
    ...mine.map((m) => ({ ...m, generic: generics.get(norm(m.name)) ?? null, source: 'mine' })),
    ...fromFormulary,
  ];
};

/**
 * The doctor's diagnoses, most frequent first, each with the medicines they
 * wrote the last time — so "Viral fever" can bring back their usual pad.
 */
export const prescribingPatterns = async ({ doctorId }) => {
  if (!doctorId) return { diagnoses: [] };
  const rows = await Prescription.aggregate([
    { $match: { doctorId: new mongoose.Types.ObjectId(String(doctorId)) } },
    { $sort: { createdAt: -1 } },
    { $limit: 1000 },
    {
      $group: {
        _id: { $toLower: { $trim: { input: '$diagnosis' } } },
        diagnosis: { $first: '$diagnosis' },
        medicines: { $first: '$medicines' },
        advice: { $first: '$advice' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, diagnosis: 1 } },
    { $limit: 40 },
  ]);
  return { diagnoses: rows.map(({ _id, ...r }) => r) };
};
