// Asking the browser where the device is: the "I'm at the hospital" backup on the New Request form
// (HospitalLocationField) and the location button at sign-up (RegisterPage).

/**
 * Options for navigator.geolocation.getCurrentPosition: a new position, never one the browser kept
 * from earlier (maximumAge 0), and an error once it has looked for 20 seconds, instead of the
 * default of waiting with no limit.
 */
export const DEVICE_LOCATION_OPTIONS = { timeout: 20 * 1000, maximumAge: 0 };

// GeolocationPositionError codes, from the Geolocation API
const PERMISSION_DENIED = 1;
const TIMEOUT = 3;

/**
 * What to tell the person when the device's position could not be read. The caller adds what
 * they can do instead.
 * @param {GeolocationPositionError | { code?: number }} error
 */
export const describeDeviceLocationError = (error) => {
  switch (error?.code) {
    case PERMISSION_DENIED:
      return "Your browser didn't let Donor use your location. Allow location access for this site, then try again.";
    case TIMEOUT:
      return `Your device didn't find its location within ${DEVICE_LOCATION_OPTIONS.timeout / 1000} seconds. Try again.`;
    default:
      return "Your device couldn't find its location. Try again.";
  }
};
