import {
  Hospital, Doctor, OPDToken, Transaction, PettyExpense, Prescription, User,
} from '../../models/index.js';
import { TOKEN_STATUS, NETWORK_STATE } from '../../config/constants.js';
import { clinicDate } from '../../lib/dates.js';
import { resolveRange } from '../pos/desk.js';
import { closureReason } from '../../services/availability.js';

/**
 * Network-wide views for the Super Admin: analytics over any day or range,
 * the financial audit with petty cash, and the live OPD monitor.
 *
 * Dates are clinic-local strings like everywhere else. The network spans one
 * timezone today, so the default timezone stands in for "the clinic's day";
 * if clinics ever span zones this is the place to group by each one's own.
 */

const ZERO_MONEY = { revenue: 0, cash: 0, upi: 0, card: 0, receipts: 0 };

const moneyBy = (match, key) => Transaction.aggregate([
  { $match: { ...match, status: 'PAID' } },
  {
    $group: {
      _id: key,
      revenue: { $sum: '$totalFee' },
      cash: { $sum: '$tender.cash' },
      upi: { $sum: '$tender.upi' },
      card: { $sum: '$tender.card' },
      receipts: { $sum: 1 },
    },
  },
]);

const footfallBy = (match, key) => OPDToken.aggregate([
  { $match: match },
  {
    $group: {
      _id: key,
      booked: { $sum: { $cond: [{ $in: ['$status', [TOKEN_STATUS.CANCELLED]] }, 0, 1] } },
      completed: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.COMPLETED] }, 1, 0] } },
      skipped: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.SKIPPED] }, 1, 0] } },
      cancelled: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.CANCELLED] }, 1, 0] } },
      walkin: { $sum: { $cond: [{ $in: ['$source', ['WALKIN', 'PHONE']] }, 1, 0] } },
      online: { $sum: { $cond: [{ $in: ['$source', ['APP', 'QR_SCAN']] }, 1, 0] } },
      emergency: { $sum: { $cond: [{ $eq: ['$visitType', 'emergency'] }, 1, 0] } },
    },
  },
]);

const pettyBy = (match, key) => PettyExpense.aggregate([
  { $match: { ...match, status: 'ACTIVE' } },
  { $group: { _id: key, total: { $sum: '$amount' }, count: { $sum: 1 } } },
]);

const rxBy = (match, key) => Prescription.aggregate([
  { $match: match },
  { $group: { _id: key, count: { $sum: 1 } } },
]);

const byId = (rows) => new Map(rows.map((r) => [String(r._id), r]));

/**
 * Totals, a trend, and a per-clinic league table over [from, to].
 * Prescriptions are counted, never read: HQ needs to know the EMR is being
 * used, not what any patient was prescribed.
 */
export const networkAnalytics = async (query = {}) => {
  const { from, to, days } = resolveRange(null, { period: 'week', ...query });
  const inRange = { date: from === to ? from : { $gte: from, $lte: to } };
  const bucket = days > 62 ? 'month' : 'day';
  const seriesKey = bucket === 'month' ? { $substrBytes: ['$date', 0, 7] } : '$date';

  const [
    hospitals, doctorCount, money, byVisit, footfall, uniquePatients,
    seriesMoney, seriesFootfall, clinicMoney, clinicFootfall, clinicPetty, clinicRx, petty, rx,
  ] = await Promise.all([
    Hospital.find().select('name networkState districtId address.city').populate('districtId', 'name').lean(),
    Doctor.countDocuments({ isActive: true }),
    moneyBy(inRange, null),
    Transaction.aggregate([
      { $match: { ...inRange, status: 'PAID' } },
      { $group: { _id: '$visitType', total: { $sum: '$totalFee' }, count: { $sum: 1 } } },
    ]),
    footfallBy(inRange, null),
    OPDToken.distinct('patientId', inRange),
    moneyBy(inRange, seriesKey),
    footfallBy(inRange, seriesKey),
    moneyBy(inRange, '$hospitalId'),
    footfallBy(inRange, '$hospitalId'),
    pettyBy(inRange, '$hospitalId'),
    rxBy(inRange, '$hospitalId'),
    pettyBy(inRange, null),
    rxBy(inRange, null),
  ]);

  const m = money[0] || ZERO_MONEY;
  const f = footfall[0] || {};
  const seriesF = byId(seriesFootfall);
  const labels = [...new Set([...seriesMoney.map((r) => r._id), ...seriesFootfall.map((r) => r._id)])].sort();

  const cm = byId(clinicMoney);
  const cf = byId(clinicFootfall);
  const cp = byId(clinicPetty);
  const cr = byId(clinicRx);

  const byClinic = hospitals
    .filter((h) => h.networkState === NETWORK_STATE.ACTIVE || cm.has(String(h._id)) || cf.has(String(h._id)))
    .map((h) => {
      const k = String(h._id);
      const mm = cm.get(k) || ZERO_MONEY;
      const ff = cf.get(k) || {};
      const pp = cp.get(k) || { total: 0, count: 0 };
      return {
        hospitalId: k,
        name: h.name,
        city: h.address?.city || '',
        district: h.districtId?.name || '—',
        networkState: h.networkState,
        revenue: mm.revenue,
        cash: mm.cash,
        upi: mm.upi,
        card: mm.card,
        receipts: mm.receipts,
        pettyCash: pp.total,
        pettyCount: pp.count,
        cashInHand: mm.cash - pp.total,
        booked: ff.booked || 0,
        completed: ff.completed || 0,
        skipped: ff.skipped || 0,
        walkin: ff.walkin || 0,
        online: ff.online || 0,
        prescriptions: cr.get(k)?.count || 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.booked - a.booked);

  return {
    from,
    to,
    days,
    bucket,
    totals: {
      revenue: m.revenue,
      cash: m.cash,
      upi: m.upi,
      card: m.card,
      receipts: m.receipts,
      avgTicket: m.receipts ? Math.round(m.revenue / m.receipts) : 0,
      pettyCash: petty[0]?.total ?? 0,
      pettyCount: petty[0]?.count ?? 0,
      booked: f.booked || 0,
      completed: f.completed || 0,
      skipped: f.skipped || 0,
      cancelled: f.cancelled || 0,
      walkin: f.walkin || 0,
      online: f.online || 0,
      emergency: f.emergency || 0,
      uniquePatients: uniquePatients.length,
      prescriptions: rx[0]?.count ?? 0,
      activeClinics: hospitals.filter((h) => h.networkState === NETWORK_STATE.ACTIVE).length,
      clinicsWithActivity: byClinic.filter((c) => c.booked > 0).length,
      activeDoctors: doctorCount,
    },
    byVisitType: byVisit.map((v) => ({ visitType: v._id || 'fresh', total: v.total, count: v.count })),
    series: labels.map((label) => {
      const mm = seriesMoney.find((r) => r._id === label) || ZERO_MONEY;
      const ff = seriesF.get(label) || {};
      return { label, revenue: mm.revenue, receipts: mm.receipts, booked: ff.booked || 0, completed: ff.completed || 0 };
    }),
    byClinic,
  };
};

/**
 * Every petty-cash entry across the network in [from, to], newest first,
 * voided ones included — the audit is about what was recorded, not only what
 * still stands.
 */
export const pettyCashAudit = async (query = {}) => {
  const { from, to } = resolveRange(null, { period: 'month', ...query });
  const filter = { date: from === to ? from : { $gte: from, $lte: to } };
  if (query.hospitalId) filter.hospitalId = query.hospitalId;

  const rows = await PettyExpense.find(filter).sort({ createdAt: -1 }).limit(1000).lean();
  const [hospitals, people] = await Promise.all([
    Hospital.find({ _id: { $in: [...new Set(rows.map((r) => String(r.hospitalId)))] } }).select('name').lean(),
    User.find({ _id: { $in: rows.flatMap((r) => [r.createdBy, r.void?.byUserId].filter(Boolean)) } }).select('name role').lean(),
  ]);
  const hName = new Map(hospitals.map((h) => [String(h._id), h.name]));
  const pName = new Map(people.map((p) => [String(p._id), p.name]));

  return {
    from,
    to,
    truncated: rows.length === 1000,
    items: rows.map((r) => ({
      id: String(r._id),
      date: r.date,
      at: r.createdAt,
      hospitalId: String(r.hospitalId),
      clinicName: hName.get(String(r.hospitalId)) || '—',
      amount: r.amount,
      category: r.category,
      note: r.note,
      status: r.status,
      by: pName.get(String(r.createdBy)) || '',
      voidReason: r.void?.reason || '',
      voidedBy: r.void?.byUserId ? pName.get(String(r.void.byUserId)) || '' : '',
    })),
  };
};

/**
 * Every doctor on the network right now: who is in the chamber, how many are
 * waiting, whether they are on a break or have closed bookings.
 */
export const liveOpd = async () => {
  const today = clinicDate();
  const [doctors, hospitals, counts, inChamber] = await Promise.all([
    Doctor.find({ isActive: true })
      .select('name specialty chamberNumber hospitalId session photo.url avgConsultMinutes scheduleOverrides')
      .lean(),
    Hospital.find({ networkState: NETWORK_STATE.ACTIVE }).select('name address.city districtId').populate('districtId', 'name').lean(),
    OPDToken.aggregate([
      { $match: { date: today } },
      {
        $group: {
          _id: '$doctorId',
          booked: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.CANCELLED] }, 0, 1] } },
          waiting: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.WAITING] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.COMPLETED] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.SKIPPED] }, 1, 0] } },
          emergencyWaiting: {
            $sum: { $cond: [{ $and: [{ $eq: ['$status', TOKEN_STATUS.WAITING] }, { $eq: ['$visitType', 'emergency'] }] }, 1, 0] },
          },
        },
      },
    ]),
    OPDToken.find({ date: today, status: TOKEN_STATUS.IN_CHAMBER })
      .select('doctorId tokenNumber enteredChamberAt calledAt').lean(),
  ]);

  const hById = new Map(hospitals.map((h) => [String(h._id), h]));
  const cById = byId(counts);
  const icById = new Map(inChamber.map((t) => [String(t.doctorId), t]));

  const rows = doctors
    .filter((d) => hById.has(String(d.hospitalId)))
    .map((d) => {
      const k = String(d._id);
      const h = hById.get(String(d.hospitalId));
      const c = cById.get(k) || {};
      const ic = icById.get(k);
      // A doctor on leave today is not "open with no queue", even if their
      // booking switch was left on.
      const offReason = closureReason(d, today);
      const state = d.session?.isOnBreak
        ? 'BREAK'
        : ic ? 'CONSULTING'
          : offReason && !(c.waiting > 0) ? 'OFF'
            : !d.session?.isBookingOpen ? 'CLOSED'
              : (c.waiting || 0) > 0 ? 'WAITING' : 'IDLE';
      return {
        doctorId: k,
        name: d.name,
        specialty: d.specialty || '',
        chamberNumber: d.chamberNumber || '',
        photoUrl: d.photo?.url || null,
        hospitalId: String(d.hospitalId),
        clinicName: h.name,
        city: h.address?.city || '',
        district: h.districtId?.name || '—',
        state,
        isBookingOpen: Boolean(d.session?.isBookingOpen),
        breakReason: d.session?.breakReason || null,
        offReason: offReason || null,
        breakUntil: d.session?.breakUntil || null,
        inChamber: ic ? { tokenNumber: ic.tokenNumber, since: ic.enteredChamberAt || ic.calledAt || null } : null,
        booked: c.booked || 0,
        waiting: c.waiting || 0,
        completed: c.completed || 0,
        skipped: c.skipped || 0,
        emergencyWaiting: c.emergencyWaiting || 0,
        // Rough, but the same estimate patients are shown.
        estimatedWaitMinutes: d.session?.isOnBreak ? null : (c.waiting || 0) * (d.avgConsultMinutes || 8),
      };
    });

  const count = (s) => rows.filter((r) => r.state === s).length;
  return {
    date: today,
    at: new Date().toISOString(),
    totals: {
      doctors: rows.length,
      consulting: count('CONSULTING'),
      waitingDoctors: count('WAITING'),
      onBreak: count('BREAK'),
      closed: count('CLOSED'),
      off: count('OFF'),
      idle: count('IDLE'),
      patientsWaiting: rows.reduce((a, r) => a + r.waiting, 0),
      patientsSeen: rows.reduce((a, r) => a + r.completed, 0),
      emergencyWaiting: rows.reduce((a, r) => a + r.emergencyWaiting, 0),
    },
    doctors: rows,
  };
};
