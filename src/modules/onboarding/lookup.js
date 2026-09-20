import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Address autocomplete for the onboarding form.
 *
 * Proxied through the server so the browser never sees the Places key, and so
 * the agent's typed city/state/PIN come from Google rather than from memory —
 * a mistyped PIN otherwise survives all the way to an admin's review queue.
 */
const realKey = () => {
  const k = (env.GOOGLE_MAPS_API_KEY || '').trim();
  return /^x+$/i.test(k) ? '' : k;
};

const AUTOCOMPLETE = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const DETAILS = 'https://maps.googleapis.com/maps/api/place/details/json';

export const suggestAddresses = async (input) => {
  if (!realKey() || !input || input.trim().length < 3) return [];
  try {
    const url = `${AUTOCOMPLETE}?input=${encodeURIComponent(input)}&components=country:in&key=${realKey()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      logger.warn({ status: data.status }, 'places autocomplete failed');
      return [];
    }
    return (data.predictions || []).slice(0, 6).map((p) => ({
      placeId: p.place_id,
      description: p.description,
      main: p.structured_formatting?.main_text ?? p.description,
      secondary: p.structured_formatting?.secondary_text ?? '',
    }));
  } catch (err) {
    logger.warn({ err: err.message }, 'places autocomplete error');
    return [];
  }
};

/** Resolve a chosen suggestion into the exact fields the form needs. */
export const resolvePlace = async (placeId) => {
  if (!realKey() || !placeId) return null;
  try {
    const url = `${DETAILS}?place_id=${encodeURIComponent(placeId)}&fields=address_component,formatted_address,geometry,name&key=${realKey()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.status !== 'OK') {
      logger.warn({ status: data.status }, 'place details failed');
      return null;
    }

    const c = data.result.address_components || [];
    const get = (type) => c.find((x) => x.types.includes(type))?.long_name ?? '';
    const loc = data.result.geometry?.location;

    // Street number and route make the usable line 1; sublocality is the
    // neighbourhood, which Indian addresses lean on heavily.
    const streetLine = [get('street_number'), get('route')].filter(Boolean).join(' ');
    const area = get('sublocality_level_1') || get('sublocality') || get('neighborhood');

    return {
      name: data.result.name ?? '',
      formatted: data.result.formatted_address ?? '',
      line1: streetLine || area || data.result.name || '',
      line2: streetLine && area ? area : '',
      city: get('locality') || get('administrative_area_level_3') || get('administrative_area_level_2'),
      state: get('administrative_area_level_1'),
      pincode: get('postal_code'),
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
      accuracy: data.result.geometry?.location_type ?? null,
      placeId,
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'place details error');
    return null;
  }
};

export const placesEnabled = () => Boolean(realKey());
