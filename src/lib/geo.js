// GeoJSON stores [longitude, latitude] — lng FIRST. Getting this backwards puts
// clinics in the wrong hemisphere and is the most common bug in geo code, so the
// conversion lives in exactly one place.

const EARTH_RADIUS_KM = 6371;

export const toPoint = (lng, lat) => ({ type: 'Point', coordinates: [Number(lng), Number(lat)] });

export const isValidLngLat = (lng, lat) =>
  Number.isFinite(Number(lng)) && Number.isFinite(Number(lat)) &&
  Math.abs(Number(lng)) <= 180 && Math.abs(Number(lat)) <= 90;

export const haversineKm = (aLng, aLat, bLng, bLat) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
};

// Rounding the origin to 3dp (~110m) is what makes the distance cache actually
// hit — raw GPS coordinates are unique per request and would never reuse an entry.
export const roundCoord = (n, dp = 3) => Number(Number(n).toFixed(dp));

export const distanceCacheKey = (lat, lng, hospitalId) =>
  `${roundCoord(lat)},${roundCoord(lng)}:${hospitalId}`;

export const round1 = (n) => Math.round(Number(n) * 10) / 10;
