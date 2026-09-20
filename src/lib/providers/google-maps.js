import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { DistanceCache } from '../../models/DistanceCache.js';
import { distanceCacheKey, haversineKm } from '../geo.js';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const DM_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';

// Process-level circuit breaker. Without it, a quota exhaustion at 11am adds
// 2.5s of timeout to every nearby search for the rest of the day.
let breakerOpenUntil = 0;
const breakerOpen = () => Date.now() < breakerOpenUntil;
const tripBreaker = (why) => {
  breakerOpenUntil = Date.now() + env.MAPS_BREAKER_COOLDOWN_MS;
  logger.warn({ why, until: new Date(breakerOpenUntil).toISOString() }, 'Google Maps circuit breaker tripped');
};

// XXXX is the documented placeholder for "key not supplied yet".
const realKey = () => {
  const k = (env.GOOGLE_MAPS_API_KEY || '').trim();
  return /^x+$/i.test(k) ? '' : k;
};

export const mapsEnabled = () => env.GOOGLE_MAPS_ENABLED && Boolean(realKey()) && !breakerOpen();

export const geocodeAddress = async ({ line1, line2, city, state, pincode }) => {
  if (!realKey()) return null;
  const address = [line1, line2, city, state, pincode].filter(Boolean).join(', ');
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&region=${env.GOOGLE_GEOCODE_REGION}&components=country:IN&key=${realKey()}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.length) {
      logger.warn({ status: data.status, address }, 'geocode returned no result');
      return null;
    }
    const best = data.results[0];
    return {
      lat: best.geometry.location.lat,
      lng: best.geometry.location.lng,
      formatted: best.formatted_address,
      placeId: best.place_id,
      // APPROXIMATE is rejected at APPROVAL time, not here — the admin gets a
      // "confirm the pin" warning. Silently accepting it drops a clinic in the
      // wrong neighbourhood and permanently corrupts nearby search.
      accuracy: best.geometry.location_type,
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'geocode request failed');
    return null;
  }
};

/**
 * Coordinates -> a readable address.
 *
 * Used when a patient shares their location: storing bare numbers means their
 * profile can only ever show "22.76, 88.37", which nobody can sanity-check.
 * Failure is not fatal — the coordinates are still the useful part.
 */
export const reverseGeocode = async ({ lat, lng }) => {
  if (!realKey()) return null;
  const url = `${GEOCODE_URL}?latlng=${lat},${lng}&region=${env.GOOGLE_GEOCODE_REGION}&key=${realKey()}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.length) {
      logger.warn({ status: data.status }, 'reverse geocode returned no result');
      return null;
    }
    const best = data.results[0];
    const part = (type) => best.address_components?.find((c) => c.types.includes(type))?.long_name ?? '';
    return {
      formatted: best.formatted_address,
      placeId: best.place_id,
      // A short label reads better on a profile than the full postal string.
      locality: part('sublocality_level_1') || part('locality') || part('administrative_area_level_2'),
      city: part('locality') || part('administrative_area_level_2'),
      pincode: part('postal_code'),
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'reverse geocode request failed');
    return null;
  }
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * Road distance + ETA for a set of hospitals.
 *
 * Deduped to distinct HOSPITALS (never doctors) because Distance Matrix bills
 * per origin×destination element. Cache is keyed on a ~110m-rounded origin,
 * which is what makes it actually hit — raw GPS never repeats.
 *
 * Always resolves. Any failure degrades to straight-line distance rather than
 * failing the search.
 */
export const distanceMatrix = async ({ origin, destinations }) => {
  const results = new Map();
  if (!destinations.length) return results;

  const keys = destinations.map((d) => ({ ...d, key: distanceCacheKey(origin.lat, origin.lng, d.id) }));

  let cached = [];
  try {
    cached = await DistanceCache.find({ key: { $in: keys.map((k) => k.key) } }).lean();
  } catch (err) {
    logger.warn({ err: err.message }, 'distance cache read failed');
  }
  const cachedByKey = new Map(cached.map((c) => [c.key, c]));

  const misses = [];
  for (const k of keys) {
    const hit = cachedByKey.get(k.key);
    if (hit) {
      results.set(k.id, { distanceMeters: hit.distanceMeters, durationSeconds: hit.durationSeconds, source: hit.source });
    } else {
      misses.push(k);
    }
  }

  if (!misses.length || !mapsEnabled()) return results;

  const batches = chunk(misses, env.DISTANCE_MATRIX_MAX_DESTINATIONS);
  // allSettled, not all: one failed batch must not blank the whole response.
  const settled = await Promise.allSettled(
    batches.map(async (batch) => {
      const dest = batch.map((b) => `${b.lat},${b.lng}`).join('|');
      const url = `${DM_URL}?origins=${origin.lat},${origin.lng}&destinations=${encodeURIComponent(dest)}&units=metric&mode=driving&departure_time=now&key=${realKey()}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(env.DISTANCE_MATRIX_TIMEOUT_MS) });
      const data = await res.json();

      if (data.status !== 'OK') {
        if (['OVER_QUERY_LIMIT', 'REQUEST_DENIED', 'INVALID_REQUEST'].includes(data.status)) {
          tripBreaker(data.status);
        }
        throw new Error(`Distance Matrix: ${data.status}`);
      }
      return { batch, elements: data.rows?.[0]?.elements ?? [] };
    }),
  );

  const toCache = [];
  const ttlMs = env.DISTANCE_CACHE_TTL_HOURS * 3600 * 1000;

  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    const { batch, elements } = s.value;
    batch.forEach((b, i) => {
      const el = elements[i];
      if (el?.status !== 'OK') return; // ZERO_RESULTS / NOT_FOUND fall back per-element
      const entry = {
        distanceMeters: el.distance.value,
        durationSeconds: (el.duration_in_traffic ?? el.duration).value,
        source: 'GOOGLE',
      };
      results.set(b.id, entry);
      toCache.push({
        updateOne: {
          filter: { key: b.key },
          update: { $set: { ...entry, key: b.key, expiresAt: new Date(Date.now() + ttlMs) } },
          upsert: true,
        },
      });
    });
  }

  if (toCache.length) {
    DistanceCache.bulkWrite(toCache, { ordered: false }).catch((err) =>
      logger.warn({ err: err.message }, 'distance cache write failed'),
    );
  }

  return results;
};

export const straightLineKm = haversineKm;
