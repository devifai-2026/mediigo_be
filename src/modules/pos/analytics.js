import mongoose from 'mongoose';
import { Transaction, OPDToken, Hospital } from '../../models/index.js';
import { TOKEN_STATUS } from '../../config/constants.js';
import { clinicDate } from '../../lib/dates.js';

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

const shiftDays = (isoDate, delta) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

export const revenueAnalytics = async ({ hospitalId, period = 'week' }) => {
  const spec = PERIODS[period] || PERIODS.week;
  const hospital = await Hospital.findById(hospitalId).lean();
  const today = clinicDate(hospital?.timezone);
  const from = shiftDays(today, -(spec.days - 1));
  const hid = new mongoose.Types.ObjectId(String(hospitalId));

  // $substrBytes over the 'YYYY-MM-DD' string rather than a date cast: the
  // field is already clinic-local, and converting it to a Date here would
  // re-introduce the timezone bug the string format exists to avoid.
  const groupKey = spec.bucket === 'month'
    ? { $substrBytes: ['$date', 0, 7] }
    : '$date';

  const [money, patients, byVisit, byPayment] = await Promise.all([
    Transaction.aggregate([
      { $match: { hospitalId: hid, date: { $gte: from, $lte: today }, status: 'PAID' } },
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
      { $match: { hospitalId: hid, date: { $gte: from, $lte: today } } },
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
      { $match: { hospitalId: hid, date: { $gte: from, $lte: today }, status: 'PAID' } },
      { $group: { _id: '$visitType', total: { $sum: '$totalFee' }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate([
      { $match: { hospitalId: hid, date: { $gte: from, $lte: today }, status: 'PAID' } },
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
  ]);

  const uniquePatients = await OPDToken.distinct('patientId', {
    hospitalId: hid, date: { $gte: from, $lte: today },
  });

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
    to: today,
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
