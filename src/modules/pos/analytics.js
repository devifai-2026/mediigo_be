import mongoose from 'mongoose';
import { Transaction, OPDToken, Hospital, Doctor } from '../../models/index.js';
import { expenseTotal, resolveRange } from './desk.js';
import { TOKEN_STATUS } from '../../config/constants.js';

/**
 * Revenue and patient analytics over a period.
 *
 * Two questions the desk actually asks — "what did we take?" and "who did we
 * see?" — answered from the same window so the two tabs can never disagree
 * about which days they cover.
 *
 * Buckets are chosen to keep a chart readable rather than to match the period
 * exactly: a year grouped by day is 365 unreadable columns, so it groups by
 * month instead.
 */
const PERIODS = {
  day: { days: 1, bucket: 'day' },
  week: { days: 7, bucket: 'day' },
  month: { days: 30, bucket: 'day' },
  '6month': { days: 182, bucket: 'month' },
  year: { days: 365, bucket: 'month' },
};

export const revenueAnalytics = async ({ hospitalId, period = 'week', doctorId = null, date, from: fromQ, to: toQ }) => {
  const hospital = await Hospital.findById(hospitalId).lean();
  // A calendar pick (one day or a range) wins over the named period.
  const { from, to, days } = resolveRange(hospital, { period: PERIODS[period] ? period : 'week', date, from: fromQ, to: toQ });
  // Day columns stay readable up to about two months; past that, months.
  const spec = { bucket: days > 62 ? 'month' : 'day' };
  const hid = new mongoose.Types.ObjectId(String(hospitalId));
  // Narrowing to one doctor applies to every figure below, so the tabs and the
  // per-doctor cards can never disagree about whose numbers they are.
  const scope = { hospitalId: hid, ...(doctorId ? { doctorId: new mongoose.Types.ObjectId(String(doctorId)) } : {}) };

  // $substrBytes over the 'YYYY-MM-DD' string rather than a date cast: the
  // field is already clinic-local, and converting it to a Date here would
  // re-introduce the timezone bug the string format exists to avoid.
  const groupKey = spec.bucket === 'month'
    ? { $substrBytes: ['$date', 0, 7] }
    : '$date';

  const [money, patients, byVisit, byPayment, byDoctorMoney, byDoctorPatients, petty, doctors] = await Promise.all([
    Transaction.aggregate([
      { $match: { ...scope, date: { $gte: from, $lte: to }, status: 'PAID' } },
      {
        $group: {
          _id: groupKey,
          total: { $sum: '$totalFee' },
          cash: { $sum: '$tender.cash' },
          upi: { $sum: '$tender.upi' },
          card: { $sum: '$tender.card' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    OPDToken.aggregate([
      { $match: { ...scope, date: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: groupKey,
          booked: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.COMPLETED] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.CANCELLED] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.SKIPPED] }, 1, 0] } },
          online: { $sum: { $cond: [{ $in: ['$source', ['APP', 'QR_SCAN']] }, 1, 0] } },
          walkin: { $sum: { $cond: [{ $in: ['$source', ['WALKIN', 'PHONE']] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { ...scope, date: { $gte: from, $lte: to }, status: 'PAID' } },
      { $group: { _id: '$visitType', total: { $sum: '$totalFee' }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate([
      { $match: { ...scope, date: { $gte: from, $lte: to }, status: 'PAID' } },
      {
        $group: {
          _id: null,
          cash: { $sum: '$tender.cash' },
          upi: { $sum: '$tender.upi' },
          card: { $sum: '$tender.card' },
          total: { $sum: '$totalFee' },
          count: { $sum: 1 },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { ...scope, date: { $gte: from, $lte: to }, status: 'PAID' } },
      { $group: { _id: '$doctorId', total: { $sum: '$totalFee' }, count: { $sum: 1 } } },
    ]),
    OPDToken.aggregate([
      { $match: { ...scope, date: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$doctorId',
          booked: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.COMPLETED] }, 1, 0] } },
        },
      },
    ]),
    // Petty cash is the desk drawer's, not a doctor's, so a per-doctor view has none.
    doctorId ? { total: 0, count: 0 } : expenseTotal(hid, from, to),
    Doctor.find({ hospitalId: hid, ...(doctorId ? { _id: doctorId } : {}) }).select('name specialty chamberNumber photo.url isActive').lean(),
  ]);

  const uniquePatients = await OPDToken.distinct('patientId', {
    ...scope, date: { $gte: from, $lte: to },
  });

  const moneyByDoc = new Map(byDoctorMoney.map((r) => [String(r._id), r]));
  const patientsByDoc = new Map(byDoctorPatients.map((r) => [String(r._id), r]));
  const byDoctor = doctors
    .filter((d) => d.isActive !== false || moneyByDoc.has(String(d._id)))
    .map((d) => ({
      doctorId: String(d._id),
      name: d.name,
      specialty: d.specialty || '',
      chamberNumber: d.chamberNumber || '',
      photoUrl: d.photo?.url || null,
      revenue: moneyByDoc.get(String(d._id))?.total ?? 0,
      receipts: moneyByDoc.get(String(d._id))?.count ?? 0,
      booked: patientsByDoc.get(String(d._id))?.booked ?? 0,
      completed: patientsByDoc.get(String(d._id))?.completed ?? 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.booked - a.booked);

  const pTotals = patients.reduce(
    (a, r) => ({
      booked: a.booked + r.booked,
      completed: a.completed + r.completed,
      cancelled: a.cancelled + r.cancelled,
      skipped: a.skipped + r.skipped,
      online: a.online + r.online,
      walkin: a.walkin + r.walkin,
    }),
    { booked: 0, completed: 0, cancelled: 0, skipped: 0, online: 0, walkin: 0 },
  );

  return {
    period,
    from,
    to,
    days,
    doctorId: doctorId ? String(doctorId) : null,
    byDoctor,
    pettyCash: petty,
    bucket: spec.bucket,
    accounts: {
      series: money.map((r) => ({ label: r._id, total: r.total, cash: r.cash, upi: r.upi, card: r.card, count: r.count })),
      totals: byPayment[0] || { cash: 0, upi: 0, card: 0, total: 0, count: 0 },
      byVisitType: byVisit.map((r) => ({ visitType: r._id || 'fresh', total: r.total, count: r.count })),
    },
    patients: {
      series: patients.map((r) => ({
        label: r._id, booked: r.booked, completed: r.completed,
        cancelled: r.cancelled, skipped: r.skipped, online: r.online, walkin: r.walkin,
      })),
      totals: { ...pTotals, unique: uniquePatients.length },
    },
  };
};
