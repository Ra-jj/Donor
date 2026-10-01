// Place search with the public OpenStreetMap Nominatim service, used by sign-up (RegisterPage) and
// by the hospital search on the New Request form (HospitalLocationField). The browser calls it
// directly; the server's CSP allows it in connect-src (server/middleware/securityHeaders.js).
//
// Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/) shapes this file:
// - a search runs only when the person asks for it (a Search button or Enter), never while typing;
// - at most one request a second from this page, shared by both forms;
// - a repeated search is answered from a cache instead of being sent again;
// - the app is identified by its Referer, which the fetch below asks for explicitly;
// - the attribution is shown next to the results, by the forms themselves.
// No saved location (the user's home) is ever sent: a search carries only what was typed.

const SEARCH_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 200;
const MIN_MS_BETWEEN_REQUESTS = 1000;
// A 429 means Nominatim is refusing this address for now, so wait far longer than one second
const MS_TO_WAIT_AFTER_RATE_LIMIT = 30 * 1000;
// A 429 sent without CORS headers can't be read: the browser reports it as a network error, the
// same as being offline. So a request that got no readable answer also waits a few seconds.
const MS_TO_WAIT_AFTER_NETWORK_ERROR = 5 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_CACHED_SEARCHES = 50;

export class PlaceSearchError extends Error {
  /**
   * @param {'too_soon' | 'rate_limited' | 'timeout' | 'network' | 'unavailable' | 'aborted'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'PlaceSearchError';
    this.code = code;
  }
}

// performance.now(), not Date.now(): a change of the device clock must not lift or stretch the wait
let nextRequestAllowedAt = 0;
// Keyed by the full request URL; the oldest entry goes first once the cache is full
const placesByRequestUrl = new Map();

/** Milliseconds before the next request may be sent; 0 when a search can run now. */
export const millisecondsUntilNextSearch = () => Math.max(0, nextRequestAllowedAt - performance.now());

/** The text as it is sent: trimmed, with runs of spaces collapsed. */
export const normalisePlaceQuery = (query) => query.trim().replace(/\s+/g, ' ');

/**
 * The search request for one query, limited to India, with English names where OpenStreetMap has
 * them, and each result's address split into parts (addressdetails).
 * @param {string} query - already normalised
 * @param {number} limit - how many results at most
 */
export const buildPlaceSearchUrl = (query, limit) => {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    countrycodes: 'in',
    limit: String(limit),
    addressdetails: '1',
    'accept-language': 'en',
  });
  return `${SEARCH_ENDPOINT}?${params}`;
};

// The kinds of place a blood request is for, by the OpenStreetMap tag Nominatim matched (its
// jsonv2 category and type). These come first in the results. A Map, so a type such as
// "constructor" can never match an inherited object property.
const HEALTH_FACILITY_KINDS = new Map([
  ['hospital', 'Hospital'],
  ['clinic', 'Clinic'],
  ['doctors', 'Doctor'],
  ['blood_bank', 'Blood bank'],
  ['blood_donation', 'Blood bank'],
  ['nursing_home', 'Nursing home'],
]);

const describeHealthFacility = (category, type) => {
  if (category === 'healthcare') return HEALTH_FACILITY_KINDS.get(type) || 'Health facility';
  if (category === 'amenity' || category === 'building') return HEALTH_FACILITY_KINDS.get(type) || null;
  return null;
};

const firstPresent = (address, keys) => keys.map((key) => address[key]).find(Boolean);

// One short line under the name: street, locality, city, state and PIN code, without repeats or
// the place's own name. Falls back to display_name when there are no address parts.
const buildAddressLine = (result, name) => {
  const address = result.address && typeof result.address === 'object' ? result.address : {};
  const street = [address.house_number, address.road].filter(Boolean);
  const stateAndPostcode = [address.state, address.postcode].filter(Boolean);
  const candidates = [
    street.length ? street.reduce((line, part) => `${line} ${part}`) : '',
    firstPresent(address, ['neighbourhood', 'suburb', 'quarter', 'hamlet']),
    firstPresent(address, ['city', 'town', 'village', 'county', 'state_district']),
    stateAndPostcode.length ? stateAndPostcode.reduce((line, part) => `${line} ${part}`) : '',
  ];
  const seen = new Set([name.toLowerCase()]);
  const parts = [];
  for (const candidate of candidates) {
    const part = typeof candidate === 'string' ? candidate.trim() : '';
    if (part && !seen.has(part.toLowerCase())) {
      seen.add(part.toLowerCase());
      parts.push(part);
    }
  }
  if (parts.length === 0 && typeof result.display_name === 'string') {
    // Everything after the name, without the country every result shares
    const segments = result.display_name.split(',').map((segment) => segment.trim());
    parts.push(...segments.filter((segment, index) => (index > 0 || segment !== name) && segment !== 'India'));
  }
  return parts.reduce((line, part) => (line ? `${line}, ${part}` : part), '');
};

// jsonv2 gives lat and lon as decimal strings. Anything else is NaN, so the result is dropped:
// Number() alone would read '' and null as 0 (a point off the coast of Africa) and accept hex.
const parseCoordinate = (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);

/**
 * One Nominatim jsonv2 result as the forms use it, or null when it has no usable position.
 * coordinates are GeoJSON order, [longitude, latitude], as the server stores them.
 */
const toPlace = (result) => {
  if (!result || typeof result !== 'object') return null;
  const longitude = parseCoordinate(result.lon);
  const latitude = parseCoordinate(result.lat);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;

  const displayName = typeof result.display_name === 'string' ? result.display_name : '';
  const name = (typeof result.name === 'string' && result.name.trim()) || displayName.split(',')[0].trim();
  if (!name) return null;

  return {
    id: String(result.place_id ?? `${result.osm_type}-${result.osm_id}`),
    name,
    addressLine: buildAddressLine(result, name),
    kind: describeHealthFacility(result.category, result.type),
    coordinates: [longitude, latitude],
  };
};

// Health facilities first, otherwise Nominatim's own order (Array.prototype.sort is stable)
const toPlaces = (results) =>
  results
    .map(toPlace)
    .filter(Boolean)
    .sort((a, b) => Number(Boolean(b.kind)) - Number(Boolean(a.kind)));

const rememberPlaces = (url, places) => {
  placesByRequestUrl.set(url, places);
  if (placesByRequestUrl.size > MAX_CACHED_SEARCHES) {
    placesByRequestUrl.delete(placesByRequestUrl.keys().next().value);
  }
};

/**
 * Searches Nominatim for places in India. Resolves with the places found (possibly none); rejects
 * with a PlaceSearchError. Answers a repeated search from the cache without a request. Rejects with
 * 'too_soon' when the one-second wait between requests has not passed; callers disable their
 * Search button for that time (millisecondsUntilNextSearch), so this is the last line of defence.
 * @param {string} query - what the person typed
 * @param {{ limit?: number, signal?: AbortSignal }} [options]
 */
export const searchPlaces = async (query, { limit = 6, signal } = {}) => {
  const url = buildPlaceSearchUrl(normalisePlaceQuery(query).slice(0, MAX_QUERY_LENGTH), limit);
  const cachedPlaces = placesByRequestUrl.get(url);
  if (cachedPlaces) return cachedPlaces;

  if (millisecondsUntilNextSearch() > 0) {
    throw new PlaceSearchError('too_soon', 'Searches are limited to one a second.');
  }
  // Counted from the moment of sending, failed requests included
  nextRequestAllowedAt = performance.now() + MIN_MS_BETWEEN_REQUESTS;

  const controller = new AbortController();
  let hasTimedOut = false;
  const timeoutId = setTimeout(() => {
    hasTimedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const abortForCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abortForCaller, { once: true });

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // The app's own Referrer-Policy (helmet, server/middleware/securityHeaders.js) already sends
      // the origin cross-site. Set here too, so Nominatim can identify the app even if that
      // header changes; the page path never leaves the browser.
      referrerPolicy: 'strict-origin-when-cross-origin',
    });

    if (response.status === 429) {
      nextRequestAllowedAt = performance.now() + MS_TO_WAIT_AFTER_RATE_LIMIT;
      throw new PlaceSearchError('rate_limited', 'Nominatim answered 429 Too Many Requests.');
    }
    if (!response.ok) {
      throw new PlaceSearchError('unavailable', `Nominatim answered HTTP ${response.status}.`);
    }

    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new PlaceSearchError('unavailable', 'Nominatim answered with something other than a JSON array.');
    }
    const places = toPlaces(body);
    rememberPlaces(url, places);
    return places;
  } catch (error) {
    if (error instanceof PlaceSearchError) throw error;
    if (hasTimedOut) {
      throw new PlaceSearchError('timeout', `Nominatim did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    if (signal?.aborted) throw new PlaceSearchError('aborted', 'The search was cancelled.');
    // response.json() on a body that is not JSON
    if (error instanceof SyntaxError) {
      throw new PlaceSearchError('unavailable', 'Nominatim answered with a body that is not JSON.');
    }
    // fetch rejects with a TypeError when no response arrives (offline, DNS, a blocked request),
    // or when the response has no CORS headers
    nextRequestAllowedAt = Math.max(nextRequestAllowedAt, performance.now() + MS_TO_WAIT_AFTER_NETWORK_ERROR);
    throw new PlaceSearchError('network', `No answer from Nominatim: ${error.message}`);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortForCaller);
  }
};

/**
 * What to tell the person when a search fails, or null for a search they cancelled by leaving the page.
 * @param {unknown} error
 */
export const describePlaceSearchError = (error) => {
  switch (error instanceof PlaceSearchError ? error.code : 'network') {
    case 'aborted':
      return null;
    case 'too_soon':
      return 'Wait a moment, then search again.';
    case 'rate_limited':
      return 'The place search asked Donor to slow down. Wait 30 seconds, then search again.';
    case 'timeout':
      return 'The place search took too long to answer. Search again in a moment.';
    case 'unavailable':
      return "The place search isn't working right now. Try again in a minute.";
    default:
      return "Couldn't reach the place search. Check your connection, then search again.";
  }
};
