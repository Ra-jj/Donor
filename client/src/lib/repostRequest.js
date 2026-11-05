// "Post again" on a requester's own expired request (pages/DashboardPage.jsx, pages/ProfilePage.jsx)
// opens the New Request form filled in with that request's details, carried in the router state of
// the navigation. Nothing is sent: the requester checks the form and submits it themselves.
//
// Router state is kept in the browser's history entry, so the form reads it as untrusted input:
// an old entry, another window or a hand-made history.pushState can hold anything. Each field is used
// only if it is one the form could have produced itself, and is otherwise left at the form's default.
import { URGENCY_LEVELS } from './urgencyLevels';
import { fitHospitalName } from './hospitalName';

// The form's choices (pages/CreateRequestPage.jsx) and the server's limits
// (server/validators/requestValidator.js)
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const MIN_UNITS = 1;
const MAX_UNITS = 20;
const MIN_HOSPITAL_NAME_LENGTH = 2;

/**
 * The router state for "Post again". Only the fields the form takes, as plain values, so the
 * history entry holds nothing else of the request (no id, status or donor).
 * @param {{ bloodGroup: string, unitsNeeded: number, hospitalName: string, urgency: string, hospitalLocation?: { coordinates?: number[] } }} request
 */
export const buildRepostState = (request) => ({
  repost: {
    bloodGroup: request.bloodGroup,
    unitsNeeded: request.unitsNeeded,
    hospitalName: request.hospitalName,
    urgency: request.urgency,
    // [longitude, latitude]
    hospitalCoordinates: request.hospitalLocation?.coordinates,
  },
});

// [longitude, latitude] inside the ranges the server accepts, or null
const readCoordinates = (value) => {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [longitude, latitude] = value;
  const isValid =
    Number.isFinite(longitude) && Number.isFinite(latitude) &&
    longitude >= -180 && longitude <= 180 &&
    latitude >= -90 && latitude <= 90;
  return isValid ? [longitude, latitude] : null;
};

/**
 * The form's starting values from router state, or null when the state holds no "Post again", or
 * none with a usable blood group or hospital name. Never throws, whatever the state holds.
 * @param {unknown} routerState - location.state
 * @returns {null | {
 *   formData: { bloodGroup: string, unitsNeeded: number, hospitalName: string, urgency: string },
 *   hospitalLocation: null | { coordinates: number[], source: 'search', name: string },
 * }}
 */
export const readRepostDraft = (routerState) => {
  const draft = routerState?.repost;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;

  const bloodGroup = BLOOD_GROUPS.includes(draft.bloodGroup) ? draft.bloodGroup : '';
  const unitsNeeded =
    Number.isInteger(draft.unitsNeeded) && draft.unitsNeeded >= MIN_UNITS && draft.unitsNeeded <= MAX_UNITS
      ? draft.unitsNeeded
      : MIN_UNITS;
  const urgency = URGENCY_LEVELS.some(({ value }) => value === draft.urgency) ? draft.urgency : 'medium';
  const trimmedName = typeof draft.hospitalName === 'string' ? draft.hospitalName.trim() : '';
  const hospitalName = trimmedName.length >= MIN_HOSPITAL_NAME_LENGTH ? fitHospitalName(trimmedName) : '';
  const coordinates = readCoordinates(draft.hospitalCoordinates);
  // Nothing the form would show (the point counts only together with a name): no draft at all, so
  // the "post again" note never sits over an empty form
  if (!bloodGroup && !hospitalName) return null;

  return {
    formData: { bloodGroup, unitsNeeded, hospitalName, urgency },
    // The hospital counts as picked, as if this name had been chosen from the hospital search, only
    // when both the name and the point are usable. Otherwise the requester searches for it again.
    hospitalLocation: hospitalName && coordinates ? { coordinates, source: 'search', name: hospitalName } : null,
  };
};
