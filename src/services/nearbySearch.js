import { Hospital, Doctor, OPDToken } from '../models/index.js';
import { distanceMatrix } from '../lib/providers/google-maps.js';
import { round1 } from '../lib/geo.js';
import { clinicDate } from '../lib/dates.js';
import { env } from '../config/env.js';
import { NETWORK_STATE, TOKEN_STATUS } from '../config/constants.js';

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Nearby doctor discovery.
 *
 * $geoNear must be the first aggregation stage. It returns the distance for
 * free, pre-sorted, and its `query` prunes to ACTIVE hospitals inside the index
 * scan — so a SUSPENDED or DEBOARDED clinic can never surface to a patient.
 */
export const findNearbyDoctors = async ({ lng, lat, radiusKm, specialty, search, limit = 30 }) => {
  const radius = Math.min(radiusKm || env.NEARBY_DEFAULT_RADIUS_KM, env.NEARBY_MAX_RADIUS_KM);

  const hospitals = await Hospital.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
        distanceField: 'crowMeters',
        maxDistance: radius * 1000,
        spherical: true,
        query: { networkState: NETWORK_STATE.ACTIVE },
        key: 'location',
      },
    },
    // MongoDB 8 removed $geoNear's own `limit`; results arrive already sorted by
    // distance, so a $limit immediately after is equivalent and supported.
    { $limit: env.NEARBY_MAX_HOSPITALS },
    { $addFields: { crowKm: { $divide: ['$crowMeters', 1000] } } },
    {
      $lookup: {
        from: 'doctors',
        let: { hid: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$hospitalId', '$$hid'] },
              isActive: true,
              ...(specialty ? { specialty: new RegExp(`^${escapeRegex(specialty)}$`, 'i') } : {}),
              ...(search ? { $or: [{ name: new RegExp(escapeRegex(search), 'i') }, { specialty: new RegExp(escapeRegex(search), 'i') }] } : {}),
            },
          },
          {
            $project: {
              name: 1, specialty: 1, qualifications: 1, fees: 1, chamberNumber: 1,
              session: 1, experienceYears: 1, avgConsultMinutes: 1, languages: 1,
            },
          },
        ],
        as: 'doctors',
      },
    },
    { $match: { 'doctors.0': { $exists: true } } },
    { $project: { name: 1, code: 1, type: 1, address: 1, location: 1, crowKm: 1, doctors: 1, subscriptionPlan: 1, contactPhone: 1 } },
  ]);

  if (!hospitals.length) {
    return { meta: { distanceSource: 'NONE', radiusKm: radius, count: 0 }, data: [] };
  }

  // One batched query for live queue depth — never one per doctor.
  const doctorIds = hospitals.flatMap((h) => h.doctors.map((d) => d._id));
  const date = clinicDate();
  const depth = await OPDToken.aggregate([
    { $match: { doctorId: { $in: doctorIds }, date, status: { $in: [TOKEN_STATUS.WAITING, TOKEN_STATUS.IN_CHAMBER] } } },
    {
      $group: {
        _id: '$doctorId',
        waiting: { $sum: { $cond: [{ $eq: ['$status', TOKEN_STATUS.WAITING] }, 1, 0] } },
        current: { $max: { $cond: [{ $eq: ['$status', TOKEN_STATUS.IN_CHAMBER] }, '$tokenNumber', 0] } },
      },
    },
  ]);
  const depthBy = new Map(depth.map((d) => [String(d._id), d]));

  // Road distance, deduped to distinct hospitals.
  const dm = await distanceMatrix({
    origin: { lat: Number(lat), lng: Number(lng) },
    destinations: hospitals.map((h) => ({
      id: String(h._id),
      lat: h.location.coordinates[1],
      lng: h.location.coordinates[0],
    })),
  });

  let anyGoogle = false;
  let anyFallback = false;

  const rows = [];
  for (const h of hospitals) {
    const hit = dm.get(String(h._id));
    if (hit) anyGoogle = true; else anyFallback = true;

    const hospitalView = {
      id: String(h._id),
      name: h.name,
      code: h.code,
      type: h.type,
      address: h.address,
      contactPhone: h.contactPhone,
      coordinates: { lng: h.location.coordinates[0], lat: h.location.coordinates[1] },
      distanceKm: hit ? round1(hit.distanceMeters / 1000) : round1(h.crowKm),
      etaMinutes: hit ? Math.round(hit.durationSeconds / 60) : null,
      distanceSource: hit ? 'GOOGLE' : 'HAVERSINE',
    };

    for (const d of h.doctors) {
      const q = depthBy.get(String(d._id));
      const onBreak = Boolean(d.session?.isOnBreak);
      const waiting = q?.waiting ?? 0;
      rows.push({
        doctorId: String(d._id),
        name: d.name,
        specialty: d.specialty,
        qualifications: d.qualifications,
        experienceYears: d.experienceYears,
        languages: d.languages,
        fees: d.fees,
        chamberNumber: d.chamberNumber,
        session: {
          isBookingOpen: Boolean(d.session?.isBookingOpen),
          isOnBreak: onBreak,
          breakReason: d.session?.breakReason ?? null,
          breakUntil: d.session?.breakUntil ?? null,
        },
        queue: {
          waiting,
          currentToken: q?.current ?? 0,
          nextToken: waiting + (q?.current ?? 0) + 1,
          // Null while on break: publishing a countdown for a queue that is not
          // advancing would be a lie.
          estimatedWaitMinutes: onBreak ? null : waiting * (d.avgConsultMinutes || env.MINUTES_PER_CONSULT),
        },
        hospital: hospitalView,
      });
    }
  }

  // Never mix sort keys. A list half-ordered by road ETA and half by crow-flight
  // is visibly wrong, so if any row lacks an ETA the whole list sorts by distance.
  const canSortByEta = anyGoogle && !anyFallback;
  rows.sort((a, b) =>
    canSortByEta
      ? a.hospital.etaMinutes - b.hospital.etaMinutes
      : a.hospital.distanceKm - b.hospital.distanceKm,
  );

  return {
    meta: {
      distanceSource: anyGoogle && anyFallback ? 'MIXED' : anyGoogle ? 'GOOGLE' : 'HAVERSINE',
      sortedBy: canSortByEta ? 'etaMinutes' : 'distanceKm',
      radiusKm: radius,
      count: rows.length,
    },
    data: rows.slice(0, limit),
  };
};
