/**
 * Location Privacy Helpers
 *
 * Donor home coordinates must never leave the server. When a requester needs to see where
 * matched donors are, we send coarse map pins instead: each coordinate is rounded to
 * 2 decimal places, roughly a 1.1 km grid, and donors that land on the same grid point
 * share one pin.
 */

const PIN_DECIMAL_PLACES = 2;
const PIN_SCALE = 10 ** PIN_DECIMAL_PLACES;

// Rounding to 2 decimals moves a point by at most 0.005 degrees on each axis: up to ~0.56 km
// north-south and ~0.56 km * cos(latitude) east-west, so at most ~0.79 km on the diagonal
// (worst at the equator). Searching this much beyond a radius therefore fetches every donor
// whose ROUNDED point is inside that radius. 2 km rather than 1 km also covers the looser
// meridian-plus-parallel bound (~1.11 km); the only cost is a few extra candidate donors.
const PIN_CANDIDATE_MARGIN_KM = 2;

/**
 * Rounds one longitude or latitude to PIN_DECIMAL_PLACES.
 *
 * Rounding is half away from zero on the decimal value as written, so it is symmetric
 * around 0: 12.345 -> 12.35 and -12.345 -> -12.35. Plain Math.round is not symmetric
 * (Math.round(-1234.5) is -1234), and 1.005 * 100 is 100.49999999999999 in binary floating
 * point, so we first trim that multiplication noise with toPrecision(15).
 * Dividing the rounded integer by 100 (rather than multiplying by 0.01) returns the double
 * closest to the 2-decimal value, so the result serialises cleanly, e.g. 77.59 and never
 * 77.59000000000001.
 *
 * @param {number} value - A longitude or latitude in degrees
 * @returns {number} The value rounded to PIN_DECIMAL_PLACES
 */
const roundCoordinate = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Coordinate must be a finite number, received ${value}`);
  }

  const scaled = Number((Math.abs(value) * PIN_SCALE).toPrecision(15));
  const rounded = (Math.sign(value) * Math.round(scaled)) / PIN_SCALE;

  // Values such as -0.001 round to -0; normalise so callers and JSON always see 0
  return rounded === 0 ? 0 : rounded;
};

/**
 * Rounds an exact [longitude, latitude] pair to a pin position.
 *
 * @param {number[]} pair - An exact [longitude, latitude] pair
 * @returns {number[]|null} The rounded pair, or null if the input is not two finite numbers
 */
const roundCoordinatePair = (pair) => {
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [longitude, latitude] = pair;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;

  return [roundCoordinate(longitude), roundCoordinate(latitude)];
};

/**
 * Turns [longitude, latitude] pairs into approximate, deduplicated map pins.
 * Pairs that are not two finite numbers are skipped rather than failing the whole response.
 * Already-rounded pairs pass through unchanged, because rounding twice gives the same result.
 * Pins are sorted by longitude, then latitude. Input order must not survive: it comes from
 * the 2dsphere index, which orders donors by their EXACT homes.
 *
 * @param {Array<number[]>} coordinatePairs - [longitude, latitude] pairs
 * @returns {Array<{ coordinates: number[] }>} One pin per rounded point, sorted by longitude then latitude
 */
const buildDonorPins = (coordinatePairs) => {
  const pinsByKey = new Map();

  coordinatePairs.forEach((pair) => {
    const coordinates = roundCoordinatePair(pair);
    if (!coordinates) return;

    const key = coordinates.join(',');
    if (!pinsByKey.has(key)) {
      pinsByKey.set(key, { coordinates });
    }
  });

  return [...pinsByKey.values()].sort(
    (a, b) => a.coordinates[0] - b.coordinates[0] || a.coordinates[1] - b.coordinates[1]
  );
};

/**
 * Great-circle distance between two [longitude, latitude] points, as an angle in radians.
 *
 * This is the spherical model MongoDB's $centerSphere uses: a point is inside a
 * $centerSphere of radius (km / EARTH_RADIUS_KM) when this angle is at most that radius.
 * Haversine form, which stays accurate for the short distances compared here.
 *
 * @param {number[]} from - [longitude, latitude] in degrees
 * @param {number[]} to - [longitude, latitude] in degrees
 * @returns {number} The central angle between the points, in radians
 */
const angularDistanceRadians = ([fromLongitude, fromLatitude], [toLongitude, toLatitude]) => {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(toLatitude - fromLatitude);
  const deltaLongitude = toRadians(toLongitude - fromLongitude);

  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(fromLatitude)) * Math.cos(toRadians(toLatitude)) * Math.sin(deltaLongitude / 2) ** 2;

  // Floating-point error can push this a hair above 1 for near-antipodal points; asin(>1) is NaN
  return 2 * Math.asin(Math.min(1, Math.sqrt(haversine)));
};

module.exports = {
  PIN_CANDIDATE_MARGIN_KM,
  roundCoordinate,
  roundCoordinatePair,
  buildDonorPins,
  angularDistanceRadians,
};
