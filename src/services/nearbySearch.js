import { Hospital, Doctor, OPDToken } from '../models/index.js';
import { distanceMatrix } from '../lib/providers/google-maps.js';
import { round1 } from '../lib/geo.js';
import { clinicDate } from '../lib/dates.js';
import { env } from '../config/env.js';
import { NETWORK_STATE, TOKEN_STATUS } from '../config/constants.js';

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every doctor's name begins "Dr.", so ranking a search term against it would
// treat that prefix as if it were part of the name.
const stripTitle = (s) => String(s || '').replace(/^\s*(dr|doctor)\.?\s+/i, '');

/**
 * Nearby doctor discovery.
 *
 * $geoNear must be the first aggregation stage. It returns the distance for
 * free, pre-sorted, and its `query` prunes to ACTIVE hospitals inside the index
 * scan — so a SUSPENDED or DEBOARDED clinic can never surface to a patient.
 */
export const findNearbyDoctors = async ({ lng, lat, radiusKm, specialty, search, limit = 30 }) => {
  const radius = Math.min(radiusKm || env.NEARBY_DEFAULT_RADIUS_KM, env.NEARBY_MAX_RADIUS_KM);
  // One compiled pattern reused by every $regexMatch below. Built once so the
  // term is escaped in exactly one place.
  const searchRe = search ? new RegExp(escapeRegex(String(search).trim()), 'i') : null;

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
    // Does the SEARCH TERM match this clinic itself — its name, city or area?
    // Computed before the doctor lookup so the lookup can use it: a search for
    // "Erandwane" should return everyone practising there, not nobody, and a
    // clinic's own name is what a patient is most likely to type after a
    // doctor's. Without this the term was only ever matched against doctors.
    {
      $addFields: {
        clinicMatches: search
          ? {
            $or: [
              { $regexMatch: { input: { $ifNull: ['$name', ''] }, regex: searchRe } },
              { $regexMatch: { input: { $ifNull: ['$address.city', ''] }, regex: searchRe } },
              { $regexMatch: { input: { $ifNull: ['$address.line1', ''] }, regex: searchRe } },
            ],
          }
          : false,
      },
    },
    {
      $lookup: {
        from: 'doctors',
        let: { hid: '$_id', clinicHit: '$clinicMatches' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$hospitalId', '$$hid'] },
                  // When the clinic itself matched, keep every doctor there.
                  // Otherwise fall back to matching the doctor's own name or
                  // specialty, which is the pre-existing behaviour.
                  search
                    ? {
                      $or: [
                        '$$clinicHit',
                        { $regexMatch: { input: { $ifNull: ['$name', ''] }, regex: searchRe } },
                        { $regexMatch: { input: { $ifNull: ['$specialty', ''] }, regex: searchRe } },
                      ],
                    }
                    : true,
                ],
              },
              isActive: true,
              ...(specialty ? { specialty: new RegExp(`^${escapeRegex(specialty)}$`, 'i') } : {}),
            },
          },
          {
            $project: {
              name: 1, specialty: 1, qualifications: 1, fees: 1, chamberNumber: 1,
              session: 1, experienceYears: 1, avgConsultMinutes: 1, languages: 1, photo: 1,
            },
          },
        ],
        as: 'doctors',
      },
    },
    { $match: { 'doctors.0': { $exists: true } } },
    // clinicMatches is deliberately absent: it is a pipeline helper, not part
    // of the response contract.
    { $project: { name: 1, code: 1, type: 1, address: 1, location: 1, crowKm: 1, doctors: 1, subscriptionPlan: 1, contactPhone: 1 } },
  ]);

  if (!hospitals.length) {
    // Nothing in range. If the term matches a doctor who simply practises
    // somewhere else, say WHERE — "no results, widen your radius" is useless
    // advice when the doctor is 1500km away and no radius would ever reach
    // them. Only runs on the empty path, so it costs nothing in the normal case.
    let elsewhere = null;
    if (searchRe) {
      const hit = await Doctor.findOne({
        isActive: true,
        $or: [{ name: searchRe }, { specialty: searchRe }],
      }).select('name specialty hospitalId').lean();
      if (hit) {
        const h = await Hospital.findById(hit.hospitalId)
          .select('name address networkState')
          .lean();
        if (h?.networkState === NETWORK_STATE.ACTIVE) {
          elsewhere = {
            name: hit.name,
            specialty: hit.specialty,
            clinicName: h.name,
            city: h.address?.city ?? null,
          };
        }
      }
    }
    return { meta: { distanceSource: 'NONE', radiusKm: radius, count: 0, elsewhere }, data: [] };
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
        // Null when none was uploaded; the card falls back to initials rather
        // than rendering a broken image.
        photoUrl: d.photo?.url ?? null,
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

/**
 * Type-ahead for the Explore search box.
 *
 * Returns doctors AND clinics in one list so a patient who half-remembers
 * either can find it, and every row carries enough context — specialty, clinic,
 * city — to tell two similar names apart before committing to a search.
 *
 * Deliberately NOT distance-filtered. Someone typing a doctor's name wants to
 * know that doctor exists and where they practise; hiding them because they are
 * outside today's radius is how a search ends up looking broken when the data
 * is fine.
 */
export const suggestSearch = async ({ q, limit = 8 }) => {
  const term = String(q || '').trim();
  // Two characters is where a prefix stops matching half the network.
  if (term.length < 2) return [];
  const re = new RegExp(escapeRegex(term), 'i');

  const [doctors, hospitals] = await Promise.all([
    Doctor.find({ isActive: true, $or: [{ name: re }, { specialty: re }] })
      .select('name specialty hospitalId photo')
      .limit(limit)
      .lean(),
    Hospital.find({
      networkState: NETWORK_STATE.ACTIVE,
      $or: [{ name: re }, { 'address.city': re }],
    })
      .select('name address')
      .limit(limit)
      .lean(),
  ]);

  const hospitalIds = [...new Set(doctors.map((d) => String(d.hospitalId)))];
  const parents = await Hospital.find({ _id: { $in: hospitalIds } })
    .select('name address networkState')
    .lean();
  const byId = new Map(parents.map((h) => [String(h._id), h]));

  const rows = [];
  for (const d of doctors) {
    const h = byId.get(String(d.hospitalId));
    // A doctor whose clinic has left the network is not bookable, so offering
    // them would lead straight to an empty result.
    if (h?.networkState !== NETWORK_STATE.ACTIVE) continue;
    rows.push({
      kind: 'doctor',
      // The value that goes into the search box when this row is picked.
      value: d.name,
      label: d.name,
      sublabel: [d.specialty, h?.name].filter(Boolean).join(' · '),
      city: h?.address?.city ?? null,
      photoUrl: d.photo?.url ?? null,
      doctorId: String(d._id),
    });
  }
  for (const h of hospitals) {
    rows.push({
      kind: 'clinic',
      value: h.name,
      label: h.name,
      sublabel: [h.address?.line1, h.address?.city].filter(Boolean).join(', '),
      city: h.address?.city ?? null,
      hospitalId: String(h._id),
    });
  }

  /**
   * Rank by how the match sits in the text, not just whether it matched.
   *
   * "adi" hits both "Dr. Aditi" and "Bibwewadi", but a typist means the former:
   * a match at the start of a WORD is intentional, one buried mid-word is
   * incidental. The title is skipped so "adi" still ranks "Dr. Aditi" first
   * rather than penalising it for starting with "Dr.".
   */
  const lower = term.toLowerCase();
  const rank = (r) => {
    const label = stripTitle(r.label).toLowerCase();
    if (label.startsWith(lower)) return 0;
    if (label.split(/\s+/).some((w) => w.startsWith(lower))) return 1;
    return 2;
  };
  rows.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  return rows.slice(0, limit);
};
