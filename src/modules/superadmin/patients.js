import mongoose from 'mongoose';
import { User, OPDToken, Transaction, Hospital, Doctor, PatientPolicy } from '../../models/index.js';
import { clinicDate, ageFrom } from '../../lib/dates.js';
import { notFound } from '../../lib/errors.js';
import { ROLES, TOKEN_STATUS, VISIT_TYPE } from '../../config/constants.js';

/**
 * Patients Master — the Super Admin's cross-network view of every person the
 * network has ever seen.
 *
 * The unit of aggregation is the OPDToken, not the User. A walk-in booked at
 * the front desk has a patientSnapshot but may never have created an account,
 * and a master that reads the User collection would simply not show them. So
 * every roll-up below starts from tokens and folds the User record in where
 * one exists.
 *
 * "Repeat" is defined per patient across the whole network rather than per
 * clinic: someone who saw a cardiologist in one clinic and a dermatologist in
 * another is a returning patient to the network, and the network is what this
 * console governs.
 */

const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return clinicDate(undefined, d);
};

// Tokens that represent a visit that actually happened. WAITING/IN_CHAMBER are
// still in flight and CANCELLED never happened, so counting them would inflate
// every footfall number on the page.
const ATTENDED = TOKEN_STATUS.COMPLETED;

/** Shared $match built from the query string, so KPIs, charts and rows agree. */
const buildMatch = ({ from, to, hospitalId, doctorId, visitType, source, status }) => {
  const match = {};

  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = from;
    if (to) match.date.$lte = to;
  }
  if (hospitalId && mongoose.isValidObjectId(hospitalId)) match.hospitalId = new mongoose.Types.ObjectId(hospitalId);
  if (doctorId && mongoose.isValidObjectId(doctorId)) match.doctorId = new mongoose.Types.ObjectId(doctorId);
  if (visitType) match.visitType = visitType;
  if (source) match.source = source;

  // Default to attended visits. `status=all` opts into the raw booking history,
  // including cancellations — useful when auditing a no-show complaint.
  if (status === 'all') { /* no status filter */ }
  else if (status) match.status = status;
  else match.status = ATTENDED;

  return match;
};

// A patient's identity across tokens. Registered patients key on their user id;
// a walk-in with no account keys on the phone captured at the desk, so their
// repeat visits collapse into one row instead of scattering.
const IDENTITY = {
  $ifNull: [
    { $toString: '$patientId' },
    { $concat: ['phone:', { $ifNull: ['$patientSnapshot.phone', 'unknown'] }] },
  ],
};

const AGE_BANDS = [
  { key: '0-12', label: 'Child (0-12)', min: 0, max: 12 },
  { key: '13-25', label: 'Youth (13-25)', min: 13, max: 25 },
  { key: '26-40', label: 'Adult (26-40)', min: 26, max: 40 },
  { key: '41-60', label: 'Middle age (41-60)', min: 41, max: 60 },
  { key: '60+', label: 'Senior (60+)', min: 61, max: 200 },
];

const bandOf = (age) => {
  if (age == null) return 'unknown';
  return AGE_BANDS.find((b) => age >= b.min && age <= b.max)?.key ?? 'unknown';
};

const emptyVisitMix = () => ({ fresh: 0, followup: 0, emergency: 0 });

/**
 * The master roster: one row per patient, with their visit history rolled up.
 *
 * Paginated in the database rather than in the client, because this collection
 * grows without bound and the browser should never receive a million rows to
 * filter down to twenty.
 */
export const patientsMaster = async (query = {}) => {
  const {
    q = '',
    segment = 'all',
    page = 1,
    limit = 50,
    sort = 'recent',
  } = query;

  const match = buildMatch(query);
  const skip = (Math.max(1, Number(page)) - 1) * Math.min(200, Number(limit));
  const take = Math.min(200, Number(limit));

  const sortStage = {
    recent: { lastVisit: -1 },
    visits: { totalVisits: -1 },
    spend: { totalSpend: -1 },
    name: { name: 1 },
  }[sort] ?? { lastVisit: -1 };

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: IDENTITY,
        patientId: { $first: '$patientId' },
        name: { $last: '$patientSnapshot.name' },
        phone: { $last: '$patientSnapshot.phone' },
        gender: { $last: '$patientSnapshot.gender' },
        age: { $last: '$patientSnapshot.age' },
        totalVisits: { $sum: 1 },
        fresh: { $sum: { $cond: [{ $eq: ['$visitType', VISIT_TYPE.FRESH] }, 1, 0] } },
        followup: { $sum: { $cond: [{ $eq: ['$visitType', VISIT_TYPE.FOLLOWUP] }, 1, 0] } },
        emergency: { $sum: { $cond: [{ $eq: ['$visitType', VISIT_TYPE.EMERGENCY] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.CANCELLED] }, 1, 0] } },
        skipped: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.SKIPPED] }, 1, 0] } },
        firstVisit: { $min: '$date' },
        lastVisit: { $max: '$date' },
        hospitalIds: { $addToSet: '$hospitalId' },
        doctorIds: { $addToSet: '$doctorId' },
        lastHospitalId: { $last: '$hospitalId' },
        lastDoctorId: { $last: '$doctorId' },
        lastComplaint: { $last: '$patientSnapshot.complaint' },
        sources: { $addToSet: '$source' },
      },
    },
    {
      $addFields: {
        clinicCount: { $size: '$hospitalIds' },
        doctorCount: { $size: '$doctorIds' },
        // Anyone past their first attended visit is a returning patient.
        isRepeat: { $gt: ['$totalVisits', 1] },
      },
    },
  ];

  // Text search runs after the group so it can match the snapshot name even
  // when the same person's earlier tokens spelled it differently.
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    pipeline.push({ $match: { $or: [{ name: rx }, { phone: rx }] } });
  }

  if (segment === 'fresh') pipeline.push({ $match: { totalVisits: 1 } });
  if (segment === 'repeat') pipeline.push({ $match: { totalVisits: { $gt: 1 } } });
  if (segment === 'followup') pipeline.push({ $match: { followup: { $gt: 0 } } });
  if (segment === 'emergency') pipeline.push({ $match: { emergency: { $gt: 0 } } });
  if (segment === 'multiclinic') pipeline.push({ $match: { clinicCount: { $gt: 1 } } });

  pipeline.push({
    $facet: {
      rows: [{ $sort: sortStage }, { $skip: skip }, { $limit: take }],
      total: [{ $count: 'n' }],
    },
  });

  const [facet] = await OPDToken.aggregate(pipeline).allowDiskUse(true);
  const rows = facet?.rows ?? [];
  const total = facet?.total?.[0]?.n ?? 0;

  // Hydrate names for the ids the roll-up collected, in two queries rather than
  // a $lookup per row.
  const hospitalIds = [...new Set(rows.flatMap((r) => (r.hospitalIds ?? []).map(String)))];
  const doctorIds = [...new Set(rows.flatMap((r) => (r.doctorIds ?? []).map(String)))];
  const userIds = rows.map((r) => r.patientId).filter(Boolean);

  const [hospitals, doctors, users, spendRows] = await Promise.all([
    Hospital.find({ _id: { $in: hospitalIds } }).select('name code address districtId').populate('districtId', 'name').lean(),
    Doctor.find({ _id: { $in: doctorIds } }).select('name specialty').lean(),
    User.find({ _id: { $in: userIds } }).select('name phone email gender dob lastKnownLocation createdAt isActive').lean(),
    Transaction.aggregate([
      { $match: { patientId: { $in: userIds.map((id) => new mongoose.Types.ObjectId(String(id))) }, status: 'PAID' } },
      { $group: { _id: '$patientId', total: { $sum: '$totalFee' } } },
    ]),
  ]);

  const hospitalById = new Map(hospitals.map((h) => [String(h._id), h]));
  const doctorById = new Map(doctors.map((d) => [String(d._id), d]));
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const spendById = new Map(spendRows.map((r) => [String(r._id), r.total]));

  return {
    total,
    page: Number(page),
    limit: take,
    rows: rows.map((r) => {
      const user = r.patientId ? userById.get(String(r.patientId)) : null;
      const lastHospital = hospitalById.get(String(r.lastHospitalId));
      const lastDoctor = doctorById.get(String(r.lastDoctorId));
      // The account's date of birth outranks the snapshot age: the snapshot was
      // frozen at booking and quietly goes stale, the DOB never does.
      const age = ageFrom(user?.dob) ?? r.age ?? null;

      return {
        key: r._id,
        patientId: r.patientId ? String(r.patientId) : null,
        registered: Boolean(r.patientId),
        name: user?.name ?? r.name ?? 'Unnamed patient',
        phone: user?.phone ?? r.phone ?? '',
        email: user?.email ?? null,
        gender: user?.gender ?? r.gender ?? null,
        age,
        ageBand: bandOf(age),
        isActive: user?.isActive ?? null,
        totalVisits: r.totalVisits,
        fresh: r.fresh,
        followup: r.followup,
        emergency: r.emergency,
        cancelled: r.cancelled,
        skipped: r.skipped,
        isRepeat: r.isRepeat,
        clinicCount: r.clinicCount,
        doctorCount: r.doctorCount,
        firstVisit: r.firstVisit,
        lastVisit: r.lastVisit,
        lastComplaint: r.lastComplaint ?? null,
        sources: r.sources ?? [],
        lastClinicName: lastHospital?.name ?? '—',
        lastClinicCity: lastHospital?.address?.city ?? null,
        lastDistrict: lastHospital?.districtId?.name ?? null,
        lastDoctorName: lastDoctor?.name ?? '—',
        lastSpecialty: lastDoctor?.specialty ?? null,
        clinics: (r.hospitalIds ?? []).map((id) => hospitalById.get(String(id))?.name).filter(Boolean),
        doctors: (r.doctorIds ?? []).map((id) => doctorById.get(String(id))?.name).filter(Boolean),
        totalSpend: r.patientId ? spendById.get(String(r.patientId)) ?? 0 : 0,
        location: user?.lastKnownLocation?.coordinates
          ? {
            lng: user.lastKnownLocation.coordinates[0],
            lat: user.lastKnownLocation.coordinates[1],
            label: user.lastKnownLocation.label ?? '',
            updatedAt: user.lastKnownLocation.updatedAt ?? null,
          }
          : null,
        registeredAt: user?.createdAt ?? null,
      };
    }),
  };
};

/**
 * Everything the top of the page draws: headline counters plus the five chart
 * series. Computed over the same filter as the table so the graphs describe
 * exactly the rows underneath them.
 */
export const patientsAnalytics = async (query = {}) => {
  const today = clinicDate();
  const match = buildMatch(query);
  const last30 = Array.from({ length: 30 }, (_, i) => dayOffset(29 - i));

  // The trend chart always shows the last 30 days regardless of the table's
  // date filter, so the shape of demand stays readable while you drill in.
  const trendMatch = { ...match, date: { $in: last30 } };

  const [
    byDay, byVisitType, byClinic, byDoctor, byDistrictRows, bySource,
    perPatient, demographics, totals,
  ] = await Promise.all([
    OPDToken.aggregate([
      { $match: trendMatch },
      {
        $group: {
          _id: '$date',
          total: { $sum: 1 },
          fresh: { $sum: { $cond: [{ $eq: ['$visitType', VISIT_TYPE.FRESH] }, 1, 0] } },
          followup: { $sum: { $cond: [{ $eq: ['$visitType', VISIT_TYPE.FOLLOWUP] }, 1, 0] } },
          emergency: { $sum: { $cond: [{ $eq: ['$visitType', VISIT_TYPE.EMERGENCY] }, 1, 0] } },
        },
      },
    ]),
    OPDToken.aggregate([
      { $match: match },
      { $group: { _id: '$visitType', n: { $sum: 1 } } },
    ]),
    OPDToken.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$hospitalId',
          visits: { $sum: 1 },
          patients: { $addToSet: IDENTITY },
          followup: { $sum: { $cond: [{ $eq: ['$visitType', VISIT_TYPE.FOLLOWUP] }, 1, 0] } },
        },
      },
      { $addFields: { uniquePatients: { $size: '$patients' } } },
      { $project: { patients: 0 } },
      { $sort: { visits: -1 } },
      { $limit: 10 },
    ]),
    OPDToken.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$doctorId',
          visits: { $sum: 1 },
          patients: { $addToSet: IDENTITY },
          followup: { $sum: { $cond: [{ $eq: ['$visitType', VISIT_TYPE.FOLLOWUP] }, 1, 0] } },
        },
      },
      { $addFields: { uniquePatients: { $size: '$patients' } } },
      { $project: { patients: 0 } },
      { $sort: { visits: -1 } },
      { $limit: 10 },
    ]),
    OPDToken.aggregate([
      { $match: match },
      { $lookup: { from: 'hospitals', localField: 'hospitalId', foreignField: '_id', as: 'h' } },
      { $unwind: '$h' },
      { $group: { _id: '$h.districtId', visits: { $sum: 1 }, patients: { $addToSet: IDENTITY } } },
      { $addFields: { uniquePatients: { $size: '$patients' } } },
      { $project: { patients: 0 } },
      { $sort: { visits: -1 } },
      { $limit: 12 },
    ]),
    OPDToken.aggregate([
      { $match: match },
      { $group: { _id: '$source', n: { $sum: 1 } } },
    ]),
    // Visits-per-patient, which is what separates fresh from repeat.
    OPDToken.aggregate([
      { $match: match },
      { $group: { _id: IDENTITY, visits: { $sum: 1 }, clinics: { $addToSet: '$hospitalId' } } },
      {
        $group: {
          _id: null,
          patients: { $sum: 1 },
          freshOnly: { $sum: { $cond: [{ $eq: ['$visits', 1] }, 1, 0] } },
          repeat: { $sum: { $cond: [{ $gt: ['$visits', 1] }, 1, 0] } },
          loyal: { $sum: { $cond: [{ $gte: ['$visits', 5] }, 1, 0] } },
          multiClinic: { $sum: { $cond: [{ $gt: [{ $size: '$clinics' }, 1] }, 1, 0] } },
          visits: { $sum: '$visits' },
        },
      },
    ]),
    OPDToken.aggregate([
      { $match: match },
      {
        $group: {
          _id: IDENTITY,
          gender: { $last: '$patientSnapshot.gender' },
          age: { $last: '$patientSnapshot.age' },
        },
      },
      { $group: { _id: { gender: '$gender', age: '$age' }, n: { $sum: 1 } } },
    ]),
    OPDToken.aggregate([
      {
        $facet: {
          today: [{ $match: { date: today, status: ATTENDED } }, { $count: 'n' }],
          week: [{ $match: { date: { $in: last30.slice(-7) }, status: ATTENDED } }, { $count: 'n' }],
          month: [{ $match: { date: { $in: last30 }, status: ATTENDED } }, { $count: 'n' }],
          allTime: [{ $match: { status: ATTENDED } }, { $count: 'n' }],
        },
      },
    ]),
  ]);

  const [hospitals, doctors, districts] = await Promise.all([
    Hospital.find({ _id: { $in: byClinic.map((c) => c._id) } }).select('name address').lean(),
    Doctor.find({ _id: { $in: byDoctor.map((d) => d._id) } }).select('name specialty').lean(),
    mongoose.model('District').find({ _id: { $in: byDistrictRows.map((d) => d._id).filter(Boolean) } }).select('name').lean(),
  ]);

  const hName = new Map(hospitals.map((h) => [String(h._id), h]));
  const dName = new Map(doctors.map((d) => [String(d._id), d]));
  const distName = new Map(districts.map((d) => [String(d._id), d.name]));

  const dayMap = new Map(byDay.map((r) => [r._id, r]));
  const mix = emptyVisitMix();
  byVisitType.forEach((r) => { if (r._id) mix[r._id] = r.n; });

  // Age bands and gender, derived once from the per-patient demographic pass.
  const ageBands = Object.fromEntries(AGE_BANDS.map((b) => [b.key, 0]));
  ageBands.unknown = 0;
  const genders = { M: 0, F: 0, O: 0, unknown: 0 };
  demographics.forEach((r) => {
    ageBands[bandOf(r._id.age ?? null)] += r.n;
    genders[r._id.gender ?? 'unknown'] = (genders[r._id.gender ?? 'unknown'] ?? 0) + r.n;
  });

  const p = perPatient[0] ?? { patients: 0, freshOnly: 0, repeat: 0, loyal: 0, multiClinic: 0, visits: 0 };
  const t = totals[0] ?? {};
  const pick = (arr) => arr?.[0]?.n ?? 0;

  const registeredPatients = await User.countDocuments({ role: ROLES.PATIENT });

  return {
    date: today,
    kpis: {
      uniquePatients: p.patients,
      totalVisits: p.visits,
      freshPatients: p.freshOnly,
      repeatPatients: p.repeat,
      loyalPatients: p.loyal,
      multiClinicPatients: p.multiClinic,
      repeatRate: p.patients ? Math.round((p.repeat / p.patients) * 100) : 0,
      visitsPerPatient: p.patients ? Number((p.visits / p.patients).toFixed(1)) : 0,
      registeredPatients,
      // Walk-ins who never opened an account — the gap worth closing.
      unregisteredPatients: Math.max(0, p.patients - registeredPatients),
      attendedToday: pick(t.today),
      attendedWeek: pick(t.week),
      attendedMonth: pick(t.month),
      attendedAllTime: pick(t.allTime),
    },
    charts: {
      labels: last30.map((d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })),
      dates: last30,
      total: last30.map((d) => dayMap.get(d)?.total ?? 0),
      fresh: last30.map((d) => dayMap.get(d)?.fresh ?? 0),
      followup: last30.map((d) => dayMap.get(d)?.followup ?? 0),
      emergency: last30.map((d) => dayMap.get(d)?.emergency ?? 0),
      visitMix: mix,
      sources: Object.fromEntries(bySource.map((r) => [r._id ?? 'UNKNOWN', r.n])),
      ageBands,
      genders,
      topClinics: byClinic.map((c) => ({
        id: String(c._id),
        name: hName.get(String(c._id))?.name ?? 'Unknown clinic',
        city: hName.get(String(c._id))?.address?.city ?? null,
        visits: c.visits,
        uniquePatients: c.uniquePatients,
        followup: c.followup,
      })),
      topDoctors: byDoctor.map((d) => ({
        id: String(d._id),
        name: dName.get(String(d._id))?.name ?? 'Unknown doctor',
        specialty: dName.get(String(d._id))?.specialty ?? null,
        visits: d.visits,
        uniquePatients: d.uniquePatients,
        followup: d.followup,
      })),
      byDistrict: byDistrictRows.map((d) => ({
        id: d._id ? String(d._id) : null,
        name: distName.get(String(d._id)) ?? 'Unassigned',
        visits: d.visits,
        uniquePatients: d.uniquePatients,
      })),
    },
  };
};

/**
 * One patient's complete file: who they are, where they are, and every visit
 * they have ever made with which doctor at which clinic.
 *
 * Accepts either a User id or the synthetic `phone:<number>` key the roster
 * uses for walk-ins, so every row in the table is clickable.
 */
export const patientProfile = async (key) => {
  const isPhoneKey = String(key).startsWith('phone:');
  const phoneValue = isPhoneKey ? String(key).slice('phone:'.length) : null;

  if (!isPhoneKey && !mongoose.isValidObjectId(key)) throw notFound('Patient not found');

  const tokenFilter = isPhoneKey
    ? { patientId: null, 'patientSnapshot.phone': phoneValue }
    : { patientId: new mongoose.Types.ObjectId(String(key)) };

  const [user, tokens] = await Promise.all([
    isPhoneKey
      ? User.findOne({ phone: phoneValue, role: ROLES.PATIENT }).lean()
      : User.findById(key).lean(),
    OPDToken.find(tokenFilter)
      .populate('doctorId', 'name specialty councilRegNo chamberNumber')
      .populate({
        path: 'hospitalId',
        select: 'name code address location contactPhone districtId networkState',
        populate: { path: 'districtId', select: 'name' },
      })
      .sort({ date: -1, tokenNumber: -1 })
      .limit(500)
      .lean(),
  ]);

  // A walk-in whose phone later matched a real account should show that
  // account's tokens too, rather than two half-histories.
  if (isPhoneKey && user) {
    const linked = await OPDToken.find({ patientId: user._id })
      .populate('doctorId', 'name specialty councilRegNo chamberNumber')
      .populate({
        path: 'hospitalId',
        select: 'name code address location contactPhone districtId networkState',
        populate: { path: 'districtId', select: 'name' },
      })
      .sort({ date: -1, tokenNumber: -1 })
      .limit(500)
      .lean();
    tokens.push(...linked);
    tokens.sort((a, b) => (b.date === a.date ? b.tokenNumber - a.tokenNumber : b.date.localeCompare(a.date)));
  }

  if (!user && tokens.length === 0) throw notFound('Patient not found');

  const attended = tokens.filter((t) => t.status === ATTENDED);
  const snapshot = tokens[0]?.patientSnapshot ?? {};

  const [transactions, policies] = await Promise.all([
    user
      ? Transaction.find({ patientId: user._id })
        .populate('hospitalId', 'name')
        .populate('doctorId', 'name')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean()
      : [],
    user ? PatientPolicy.find({ patientUserId: user._id }).lean().catch(() => []) : [],
  ]);

  // Per-clinic and per-doctor breakdown of where this person actually goes.
  const byClinic = new Map();
  const byDoctor = new Map();
  attended.forEach((t) => {
    const hid = String(t.hospitalId?._id ?? t.hospitalId ?? 'unknown');
    const did = String(t.doctorId?._id ?? t.doctorId ?? 'unknown');

    const c = byClinic.get(hid) ?? {
      id: hid,
      name: t.hospitalId?.name ?? 'Unknown clinic',
      city: t.hospitalId?.address?.city ?? null,
      district: t.hospitalId?.districtId?.name ?? null,
      address: t.hospitalId?.address ?? null,
      contactPhone: t.hospitalId?.contactPhone ?? null,
      coordinates: t.hospitalId?.location?.coordinates
        ? { lng: t.hospitalId.location.coordinates[0], lat: t.hospitalId.location.coordinates[1] }
        : null,
      visits: 0, ...emptyVisitMix(), firstVisit: t.date, lastVisit: t.date,
    };
    c.visits += 1;
    if (t.visitType) c[t.visitType] = (c[t.visitType] ?? 0) + 1;
    if (t.date < c.firstVisit) c.firstVisit = t.date;
    if (t.date > c.lastVisit) c.lastVisit = t.date;
    byClinic.set(hid, c);

    const d = byDoctor.get(did) ?? {
      id: did,
      name: t.doctorId?.name ?? 'Unknown doctor',
      specialty: t.doctorId?.specialty ?? null,
      regNo: t.doctorId?.councilRegNo ?? null,
      clinicName: t.hospitalId?.name ?? null,
      visits: 0, ...emptyVisitMix(), firstVisit: t.date, lastVisit: t.date,
    };
    d.visits += 1;
    if (t.visitType) d[t.visitType] = (d[t.visitType] ?? 0) + 1;
    if (t.date < d.firstVisit) d.firstVisit = t.date;
    if (t.date > d.lastVisit) d.lastVisit = t.date;
    byDoctor.set(did, d);
  });

  const visitMix = emptyVisitMix();
  attended.forEach((t) => { if (t.visitType) visitMix[t.visitType] += 1; });

  // Visit cadence: the average gap between attended visits, which is what a
  // follow-up adherence question actually asks.
  const dates = [...new Set(attended.map((t) => t.date))].sort();
  let avgGapDays = null;
  if (dates.length > 1) {
    const gaps = dates.slice(1).map((d, i) => (new Date(d) - new Date(dates[i])) / 86400000);
    avgGapDays = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  }

  const age = ageFrom(user?.dob) ?? snapshot.age ?? null;
  const spend = transactions.filter((t) => t.status === 'PAID').reduce((s, t) => s + (t.totalFee || 0), 0);
  const refunded = transactions.filter((t) => t.status === 'REFUNDED').reduce((s, t) => s + (t.refund?.amount || 0), 0);

  return {
    key: String(key),
    patientId: user ? String(user._id) : null,
    registered: Boolean(user),
    name: user?.name ?? snapshot.name ?? 'Unnamed patient',
    phone: user?.phone ?? snapshot.phone ?? '',
    email: user?.email ?? null,
    gender: user?.gender ?? snapshot.gender ?? null,
    dob: user?.dob ?? null,
    age,
    ageBand: bandOf(age),
    isActive: user?.isActive ?? null,
    aadhaarLinked: Boolean(user?.aadhaarHash),
    registeredAt: user?.createdAt ?? null,
    lastLoginAt: user?.lastLoginAt ?? null,
    familyMembers: (user?.familyMembers ?? []).map((m) => ({
      id: String(m._id),
      name: m.name,
      relation: m.relation,
      gender: m.gender ?? null,
      age: ageFrom(m.dob),
      phone: m.phone ?? null,
    })),
    location: user?.lastKnownLocation?.coordinates
      ? {
        lng: user.lastKnownLocation.coordinates[0],
        lat: user.lastKnownLocation.coordinates[1],
        label: user.lastKnownLocation.label ?? '',
        accuracy: user.lastKnownLocation.accuracy ?? null,
        updatedAt: user.lastKnownLocation.updatedAt ?? null,
      }
      : null,
    stats: {
      totalVisits: attended.length,
      totalBookings: tokens.length,
      ...visitMix,
      cancelled: tokens.filter((t) => t.status === TOKEN_STATUS.CANCELLED).length,
      skipped: tokens.filter((t) => t.status === TOKEN_STATUS.SKIPPED).length,
      rescheduled: tokens.filter((t) => t.status === TOKEN_STATUS.RESCHEDULE_NEEDED).length,
      clinicCount: byClinic.size,
      doctorCount: byDoctor.size,
      firstVisit: dates[0] ?? null,
      lastVisit: dates[dates.length - 1] ?? null,
      avgGapDays,
      isRepeat: attended.length > 1,
      totalSpend: spend,
      refunded,
    },
    clinics: [...byClinic.values()].sort((a, b) => b.visits - a.visits),
    doctors: [...byDoctor.values()].sort((a, b) => b.visits - a.visits),
    // The full chronological file — every booking, whatever became of it.
    history: tokens.map((t) => ({
      id: String(t._id),
      date: t.date,
      tokenNumber: t.tokenNumber,
      shift: t.shift,
      visitType: t.visitType,
      status: t.status,
      source: t.source,
      complaint: t.patientSnapshot?.complaint ?? null,
      bookedFor: t.familyMemberId ? (t.patientSnapshot?.name ?? 'Family member') : 'Self',
      isSelf: !t.familyMemberId,
      isPaid: t.isPaid,
      clinicName: t.hospitalId?.name ?? '—',
      clinicCity: t.hospitalId?.address?.city ?? null,
      district: t.hospitalId?.districtId?.name ?? null,
      coordinates: t.hospitalId?.location?.coordinates
        ? { lng: t.hospitalId.location.coordinates[0], lat: t.hospitalId.location.coordinates[1] }
        : null,
      doctorName: t.doctorId?.name ?? '—',
      specialty: t.doctorId?.specialty ?? null,
      calledAt: t.calledAt ?? null,
      completedAt: t.completedAt ?? null,
      skipReason: t.skipReason ?? null,
      rescheduleReason: t.rescheduleReason ?? null,
      createdAt: t.createdAt,
    })),
    transactions: transactions.map((t) => ({
      id: String(t._id),
      date: t.date,
      receiptNumber: t.receiptNumber,
      visitType: t.visitType,
      baseFee: t.baseFee,
      discount: t.discount,
      totalFee: t.totalFee,
      tender: t.tender,
      status: t.status,
      clinicName: t.hospitalId?.name ?? '—',
      doctorName: t.doctorId?.name ?? '—',
      createdAt: t.createdAt,
    })),
    policies: policies.map((p) => ({
      id: String(p._id),
      insurer: p.insurer ?? null,
      policyNumber: p.policyNumber ?? null,
      validTill: p.validTill ?? null,
    })),
  };
};

/** Clinic and doctor options for the master's filter dropdowns. */
export const patientFilterOptions = async () => {
  const [hospitals, doctors] = await Promise.all([
    Hospital.find().select('name code address districtId').populate('districtId', 'name').sort({ name: 1 }).lean(),
    Doctor.find({ isActive: true }).select('name specialty hospitalId').sort({ name: 1 }).lean(),
  ]);

  return {
    clinics: hospitals.map((h) => ({
      id: String(h._id),
      name: h.name,
      code: h.code,
      city: h.address?.city ?? null,
      district: h.districtId?.name ?? null,
    })),
    doctors: doctors.map((d) => ({
      id: String(d._id),
      name: d.name,
      specialty: d.specialty,
      hospitalId: String(d.hospitalId),
    })),
    specialties: [...new Set(doctors.map((d) => d.specialty))].sort(),
  };
};
