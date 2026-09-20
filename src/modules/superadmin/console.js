import { Hospital, Doctor, User, OPDToken, Transaction, OnboardingSubmission, District } from '../../models/index.js';
import { clinicDate } from '../../lib/dates.js';
import { ROLES, NETWORK_STATE, TOKEN_STATUS, SUBMISSION_STATUS, VISIT_TYPE } from '../../config/constants.js';

const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return clinicDate(undefined, d);
};

/**
 * One payload for the whole Super Admin console.
 *
 * The console renders eight sections and five charts off a single state object,
 * so serving it in one request keeps the client simple and avoids eight
 * round-trips on every tab switch. The field names mirror the prototype's
 * `state` object so the markup could be carried over unchanged.
 */
export const getConsole = async () => {
  const today = clinicDate();
  const last7 = Array.from({ length: 7 }, (_, i) => dayOffset(6 - i));
  const monthStart = today.slice(0, 8) + '01';

  const [hospitals, doctors, agents, executives, submissions, districts] = await Promise.all([
    Hospital.find().populate('districtId', 'name code').lean(),
    Doctor.find().lean(),
    User.find({ role: ROLES.FIELD_AGENT }).populate('districtId', 'name code').lean(),
    User.find({ role: ROLES.EXEC_ADMIN }).populate('districtId', 'name code').lean(),
    OnboardingSubmission.find().populate('agentId', 'name').lean(),
    District.find().lean(),
  ]);

  const hospitalIds = hospitals.map((h) => h._id);

  // Per-doctor attendance across today / week / month / all-time, in one pass.
  const [attToday, attWeek, attMonth, attAll, revByDoctor, trendRows, patientTrend] = await Promise.all([
    OPDToken.aggregate([
      { $match: { date: today, status: TOKEN_STATUS.COMPLETED } },
      { $group: { _id: '$doctorId', n: { $sum: 1 } } },
    ]),
    OPDToken.aggregate([
      { $match: { date: { $in: last7 }, status: TOKEN_STATUS.COMPLETED } },
      { $group: { _id: '$doctorId', n: { $sum: 1 } } },
    ]),
    OPDToken.aggregate([
      { $match: { date: { $gte: monthStart, $lte: today }, status: TOKEN_STATUS.COMPLETED } },
      { $group: { _id: '$doctorId', n: { $sum: 1 } } },
    ]),
    OPDToken.aggregate([
      { $match: { status: TOKEN_STATUS.COMPLETED } },
      { $group: { _id: '$doctorId', n: { $sum: 1 } } },
    ]),
    // Collections split by visit type — feeds the doughnut and the audit table.
    Transaction.aggregate([
      { $match: { status: 'PAID' } },
      { $lookup: { from: 'opdtokens', localField: 'tokenId', foreignField: '_id', as: 't' } },
      { $unwind: '$t' },
      { $match: { 't.status': TOKEN_STATUS.COMPLETED } },
      {
        $group: {
          _id: { doctorId: '$doctorId', visitType: '$visitType' },
          total: { $sum: '$totalFee' },
        },
      },
    ]),
    // Weekly onboarding + revenue trajectory.
    Hospital.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 7 * 86400000) } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
    ]),
    OPDToken.aggregate([
      { $match: { date: { $in: last7 }, status: TOKEN_STATUS.COMPLETED } },
      { $group: { _id: '$date', n: { $sum: 1 } } },
    ]),
  ]);

  const map = (rows) => new Map(rows.map((r) => [String(r._id), r.n]));
  const tToday = map(attToday);
  const tWeek = map(attWeek);
  const tMonth = map(attMonth);
  const tAll = map(attAll);

  const revBy = new Map();
  for (const r of revByDoctor) {
    const key = String(r._id.doctorId);
    const entry = revBy.get(key) || { fresh: 0, followup: 0, emergency: 0 };
    entry[r._id.visitType] = (entry[r._id.visitType] || 0) + r.total;
    revBy.set(key, entry);
  }

  const hospitalById = new Map(hospitals.map((h) => [String(h._id), h]));
  const agentByDistrict = new Map();
  agents.forEach((a) => {
    if (a.districtId) agentByDistrict.set(String(a.districtId._id ?? a.districtId), a);
  });

  // One row per doctor: the console's "clinic" unit is a doctor at a clinic.
  const clinics = doctors.map((d) => {
    const h = hospitalById.get(String(d.hospitalId));
    const rev = revBy.get(String(d._id)) || { fresh: 0, followup: 0, emergency: 0 };
    const agent = h?.districtId ? agentByDistrict.get(String(h.districtId._id ?? h.districtId)) : null;
    const pendingHospital = h?.networkState === NETWORK_STATE.PENDING_APPROVAL;

    return {
      id: String(d._id),
      hospitalId: String(d.hospitalId),
      doctorName: d.name,
      clinicName: h?.name ?? 'Unassigned',
      specialty: d.specialty,
      education: (d.qualifications || []).join(', '),
      experience: d.experienceYears ? `${d.experienceYears} Years` : '—',
      regNo: d.councilRegNo,
      phone: h?.contactPhone ?? '',
      address: h ? `${h.address?.line1 ?? ''}, ${h.address?.city ?? ''} ${h.address?.pincode ?? ''}` : '',
      cashFresh: rev.fresh || 0,
      cashFollowup: rev.followup || 0,
      cashEmergency: rev.emergency || 0,
      totalCash: (rev.fresh || 0) + (rev.followup || 0) + (rev.emergency || 0),
      // The console's vocabulary: Approved / Pending.
      status: pendingHospital ? 'Pending' : 'Approved',
      networkState: h?.networkState ?? NETWORK_STATE.PENDING_APPROVAL,
      // "Online" here means the doctor is actively taking bookings.
      isOnline: Boolean(d.session?.isBookingOpen),
      isOnBreak: Boolean(d.session?.isOnBreak),
      district: h?.districtId?.name ?? '—',
      agentId: agent ? String(agent._id) : null,
      agentName: agent?.name ?? 'Direct Onboard',
      patientsToday: tToday.get(String(d._id)) || 0,
      patientsWeek: tWeek.get(String(d._id)) || 0,
      patientsMonth: tMonth.get(String(d._id)) || 0,
      patientsTotal: tAll.get(String(d._id)) || 0,
    };
  });

  // Which Executive Admin owns each district — an approval card should name
  // the person accountable for it, not just the agent who filed it.
  const execByDistrict = new Map();
  executives.forEach((e) => {
    if (e.districtId) execByDistrict.set(String(e.districtId._id ?? e.districtId), e);
  });

  const subsByAgent = new Map();
  submissions.forEach((s) => {
    const k = String(s.agentId?._id ?? s.agentId);
    subsByAgent.set(k, (subsByAgent.get(k) || 0) + 1);
  });

  const agentRows = agents.map((a) => {
    const mine = clinics.filter((c) => c.agentId === String(a._id));
    return {
      id: String(a._id),
      name: a.name,
      cluster: a.districtId?.name ?? 'Unassigned',
      phone: a.phone,
      status: a.isActive ? 'Active Duty' : 'On Leave',
      totalOnboarded: subsByAgent.get(String(a._id)) || 0,
      clinicCount: mine.length,
      cashCollected: mine.reduce((s, c) => s + c.totalCash, 0),
      clinics: mine.map((c) => ({ clinicName: c.clinicName, doctorName: c.doctorName, totalCash: c.totalCash })),
    };
  });

  const executiveRows = executives.map((e) => ({
    id: String(e._id),
    name: e.name,
    role: 'Regional Operations Lead',
    territory: e.districtId?.name ? `${e.districtId.name} District` : 'All Zones (HQ)',
    email: e.email ?? '—',
    phone: e.phone,
    status: e.isActive ? 'Active' : 'Inactive',
  }));

  // Pending onboarding submissions surface as the approvals queue.
  const approvals = submissions
    .filter((s) => [SUBMISSION_STATUS.SUBMITTED, SUBMISSION_STATUS.UNDER_REVIEW].includes(s.status))
    .map((s) => ({
      id: String(s._id),
      kind: s.kind,
      clinicName: s.payload?.name ?? '—',
      doctorName: s.payload?.primaryContact?.name ?? '—',
      specialty: s.payload?.type ?? 'CLINIC',
      education: s.payload?.licenseNumber ?? '—',
      regNo: s.payload?.licenseNumber ?? '—',
      address: s.payload?.address
        ? `${s.payload.address.line1}, ${s.payload.address.city} ${s.payload.address.pincode}`
        : '—',
      agentName: s.agentId?.name ?? '—',
      districtName: districts.find((d) => String(d._id) === String(s.districtId))?.name ?? '—',
      execAdminName: execByDistrict.get(String(s.districtId))?.name ?? 'Unassigned',
      hasGeocode: Boolean(s.geocodeResult?.lat),
      cashFresh: 0,
      cashFollowup: 0,
      cashEmergency: 0,
      totalCash: 0,
    }));

  // Clinic-level rollup: the directory's primary unit is the clinic, with its
  // doctors nested. The flat doctor list stays for the tables that need it.
  const clinicRollup = hospitals.map((h) => {
    const mine = clinics.filter((c) => c.hospitalId === String(h._id));
    const agent = h.districtId ? agentByDistrict.get(String(h.districtId._id ?? h.districtId)) : null;
    const sum = (f) => mine.reduce((a, c) => a + (c[f] || 0), 0);
    return {
      id: String(h._id),
      name: h.name,
      code: h.code,
      type: h.type,
      licenseNumber: h.licenseNumber,
      networkState: h.networkState,
      subscriptionPlan: h.subscriptionPlan,
      address: h.address,
      contactPhone: h.contactPhone ?? null,
      district: h.districtId?.name ?? '—',
      districtId: h.districtId?._id ? String(h.districtId._id) : null,
      coordinates: h.location?.coordinates
        ? { lng: h.location.coordinates[0], lat: h.location.coordinates[1] }
        : null,
      geocodeAccuracy: h.geocode?.accuracy ?? null,
      agentName: agent?.name ?? 'Direct Onboard',
      doctorCount: mine.length,
      onlineDoctors: mine.filter((c) => c.isOnline).length,
      onBreakDoctors: mine.filter((c) => c.isOnBreak).length,
      specialties: [...new Set(mine.map((c) => c.specialty))],
      cashFresh: sum('cashFresh'),
      cashFollowup: sum('cashFollowup'),
      cashEmergency: sum('cashEmergency'),
      totalCash: sum('totalCash'),
      patientsToday: sum('patientsToday'),
      patientsTotal: sum('patientsTotal'),
      suspendedAt: h.suspendedAt ?? null,
      deboardedAt: h.deboardedAt ?? null,
      createdAt: h.createdAt,
      doctors: mine,
    };
  });

  const trendBy = new Map(trendRows.map((r) => [r._id, r.n]));
  const patientBy = new Map(patientTrend.map((r) => [r._id, r.n]));
  const labels = last7.map((d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short' }));

  const revenueByDay = await Transaction.aggregate([
    { $match: { date: { $in: last7 }, status: 'PAID' } },
    { $group: { _id: '$date', total: { $sum: '$totalFee' } } },
  ]);
  const revBydayMap = new Map(revenueByDay.map((r) => [r._id, r.total]));

  return {
    date: today,
    clinics,
    clinicRollup,
    agents: agentRows,
    executives: executiveRows,
    approvals,
    districts: districts.map((d) => ({ id: String(d._id), name: d.name, code: d.code, cityTier: d.cityTier })),
    hospitals: hospitals.map((h) => ({
      id: String(h._id),
      name: h.name,
      code: h.code,
      networkState: h.networkState,
      district: h.districtId?.name ?? '—',
    })),
    // Series for the five charts.
    charts: {
      labels,
      onboarded: last7.map((d) => trendBy.get(d) || 0),
      // Prototype plots revenue in ₹100s so both series share one axis.
      revenueHundreds: last7.map((d) => Math.round((revBydayMap.get(d) || 0) / 100)),
      patients: last7.map((d) => patientBy.get(d) || 0),
    },
  };
};
