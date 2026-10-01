import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import toast from 'react-hot-toast';
import { CheckCircleIcon, HospitalIcon, MagnifyingGlassIcon, MapPinIcon } from '@phosphor-icons/react';
import MapErrorBoundary from './MapErrorBoundary';
import { DEVICE_LOCATION_OPTIONS, describeDeviceLocationError } from '../lib/deviceLocation';
import { loadDonorMap } from '../lib/loadDonorMap';
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, describePlaceSearchError, normalisePlaceQuery } from '../lib/nominatim';
import { usePlaceSearch } from '../lib/usePlaceSearch';

// The same lazy chunk as the success screen's map; CreateRequestPage preloads it when it mounts
const DonorMap = lazy(loadDonorMap);

// The page focuses this input when the form is sent without a hospital location
export const HOSPITAL_SEARCH_INPUT_ID = 'hospital-search';
const STATUS_ID = 'hospital-search-status';
const HELP_ID = 'hospital-search-help';
const ERROR_ID = 'hospital-location-error';
const DEVICE_NOTE_ID = 'hospital-device-note';
const RESULT_LIMIT = 6;
const USE_LOCATION_HINT = "If you're at the hospital, you can use your location below instead.";
// The loading, success and error messages of one "I'm at the hospital" request share this id
const DEVICE_TOAST_ID = 'geo';

/**
 * Where the hospital is: a place picked from a Nominatim search (the main way), or the device's
 * position for someone who is at the hospital (the backup). The page owns the value:
 * - location: null, or { coordinates: [longitude, latitude], source: 'search' | 'device', name?, addressLine? }
 * - onPlacePicked(place): a search result was chosen; the page also fills the hospital name from it
 * - onLocationChange(location): the device's position, or null to clear a picked place
 * - error: why the form can't be sent yet (no location), or the server's message for the field
 * - disabled: true while the form is being sent, so nothing here can change the location
 */
const HospitalLocationField = ({ location, onPlacePicked, onLocationChange, error, disabled = false }) => {
  const [query, setQuery] = useState('');
  // { query, places }: the results always belong to the text in the box, and go when it changes
  const [results, setResults] = useState(null);
  // code: the PlaceSearchError code behind a problem, so a 429's longer wait isn't talked over
  const [status, setStatus] = useState({ isProblem: false, message: '', code: null });
  const { search, isSearching, isSearchBlocked } = usePlaceSearch();
  // The text in the box when a search answers, which may have changed while it ran
  const latestQueryRef = useRef('');
  const confirmationRef = useRef(null);
  const shouldFocusConfirmationRef = useRef(false);
  // Each "I'm at the hospital" request takes the next number, and a position or error that arrives
  // for an older one is dropped. A pick, new search text, sending the form and leaving the page
  // all move the number on, so a slow position never replaces a later choice.
  const deviceRequestRef = useRef(0);
  const isDeviceRequestPendingRef = useRef(false);

  const cancelPendingDeviceRequest = useCallback(() => {
    deviceRequestRef.current += 1;
    if (isDeviceRequestPendingRef.current) {
      isDeviceRequestPendingRef.current = false;
      toast.dismiss(DEVICE_TOAST_ID);
    }
  }, []);

  // While the form is being sent the location must stay what was sent
  useEffect(() => {
    if (disabled) cancelPendingDeviceRequest();
  }, [disabled, cancelPendingDeviceRequest]);
  // After a successful send this field is gone, and so is any reason to wait for a position
  useEffect(() => () => cancelPendingDeviceRequest(), [cancelPendingDeviceRequest]);

  // After a pick the chosen result is gone from the page, so focus moves to the confirmation of it
  useEffect(() => {
    if (location && shouldFocusConfirmationRef.current) {
      shouldFocusConfirmationRef.current = false;
      confirmationRef.current?.focus();
    }
  }, [location]);

  const handleQueryChange = (event) => {
    setQuery(event.target.value);
    latestQueryRef.current = event.target.value;
    setResults(null);
    // A problem stays while the Search button is still disabled (e.g. 30 seconds after a 429), so
    // the disabled button keeps its explanation
    if (!(isSearchBlocked && status.isProblem)) setStatus({ isProblem: false, message: '', code: null });
    // A picked place belongs to the text it was found with, so a hospital name never sits with a
    // stale point. The device's position doesn't depend on the text and stays once it has arrived.
    if (location?.source === 'search') onLocationChange(null);
    // But one still on its way is dropped: searching means the person has moved on from the
    // backup, and a position landing unseen while they type could be far from the hospital
    cancelPendingDeviceRequest();
  };

  const runSearch = async () => {
    const searchedQuery = normalisePlaceQuery(query);
    if (searchedQuery.length < MIN_QUERY_LENGTH) {
      setResults(null);
      setStatus({ isProblem: true, message: `Type at least ${MIN_QUERY_LENGTH} letters of the hospital's name or area.`, code: null });
      return;
    }
    // The results on screen are already the answer for this text
    if (results?.query === searchedQuery) return;

    try {
      const places = await search(searchedQuery, { limit: RESULT_LIMIT });
      // null: a search is already running, and its answer sets the status
      if (places === null) return;
      // The text changed while the search ran; its results would not match the box
      if (normalisePlaceQuery(latestQueryRef.current) !== searchedQuery) return;
      setResults({ query: searchedQuery, places });
      setStatus(
        places.length > 0
          ? {
              isProblem: false,
              message: `${places.length} ${places.length === 1 ? 'place' : 'places'} found. Choose the hospital to set its location.`,
              code: null,
            }
          : {
              isProblem: false,
              message: `No places in India match “${searchedQuery}”. Try the hospital's full name, or add the area or city. ${USE_LOCATION_HINT}`,
              code: null,
            },
      );
    } catch (searchError) {
      const message = describePlaceSearchError(searchError);
      // null: the page is closing and cancelled the search
      if (!message) return;
      // Nothing was sent (Enter during the wait after the last search): say so, unless the
      // status already explains a longer wait after a 429
      if (searchError?.code === 'too_soon') {
        setStatus((current) => (current.code === 'rate_limited' ? current : { isProblem: true, message, code: 'too_soon' }));
        return;
      }
      console.error('Hospital search failed:', searchError);
      setResults(null);
      setStatus({ isProblem: true, message: `${message} ${USE_LOCATION_HINT}`, code: searchError?.code ?? null });
    }
  };

  const handleQueryKeyDown = (event) => {
    // Enter confirms an input method's composition (e.g. Hindi typing) first; leave that alone
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    // Enter searches; it must never send the whole request form
    event.preventDefault();
    runSearch();
  };

  const handlePick = (place) => {
    // The pick is the later choice: a position still on its way must not replace it
    cancelPendingDeviceRequest();
    shouldFocusConfirmationRef.current = true;
    setResults(null);
    setStatus({ isProblem: false, message: '', code: null });
    onPlacePicked(place);
  };

  const handleUseDeviceLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by your browser');
      return;
    }

    const requestId = ++deviceRequestRef.current;
    isDeviceRequestPendingRef.current = true;
    toast.loading('Fetching hospital location...', { id: DEVICE_TOAST_ID });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (requestId !== deviceRequestRef.current) return;
        isDeviceRequestPendingRef.current = false;
        onLocationChange({ coordinates: [position.coords.longitude, position.coords.latitude], source: 'device' });
        toast.success('Location captured successfully!', { id: DEVICE_TOAST_ID });
      },
      (geolocationError) => {
        if (requestId !== deviceRequestRef.current) return;
        isDeviceRequestPendingRef.current = false;
        console.error('Device location failed:', geolocationError);
        toast.error(`${describeDeviceLocationError(geolocationError)} Or search for the hospital instead.`, { id: DEVICE_TOAST_ID });
      },
      DEVICE_LOCATION_OPTIONS,
    );
  };

  const statusMessage = isSearching ? 'Searching…' : status.message;
  const isStatusProblem = !isSearching && status.isProblem;
  const inputDescribedBy = `${error ? `${ERROR_ID} ` : ''}${STATUS_ID} ${HELP_ID}`;

  return (
    <div>
      <label htmlFor={HOSPITAL_SEARCH_INPUT_ID} className="label">
        <span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Hospital</span>
      </label>
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <div className="absolute inset-y-0 left-0 z-10 pl-4 flex items-center pointer-events-none">
            <MagnifyingGlassIcon weight="regular" className="h-5 w-5 text-base-content/30" aria-hidden="true" />
          </div>
          <input
            id={HOSPITAL_SEARCH_INPUT_ID}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            maxLength={MAX_QUERY_LENGTH}
            className={`input w-full pl-12 rounded-xl border ${error ? 'border-error focus:border-error focus:ring-error' : 'border-base-300 focus:border-primary focus:ring-primary'} bg-base-100 shadow-sm focus:ring-1 transition-all text-base`}
            placeholder="Search hospital name or area"
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleQueryKeyDown}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={inputDescribedBy}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary w-full sm:w-auto rounded-xl font-bold active:scale-98 transition-transform"
          onClick={runSearch}
          disabled={disabled || isSearchBlocked}
        >
          {isSearching && <span className="loading loading-spinner loading-sm" aria-hidden="true"></span>}
          Search
        </button>
      </div>

      {error && (
        <p id={ERROR_ID} role="alert" className="text-error text-sm mt-2 font-medium">
          {error}
        </p>
      )}

      {/* Always on the page, so screen readers announce each new message */}
      <p
        id={STATUS_ID}
        role="status"
        className={`text-sm ${statusMessage ? 'mt-2' : ''} ${isStatusProblem ? 'text-error font-medium' : 'text-base-content/70'}`}
      >
        {statusMessage}
      </p>

      {results && results.places.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label={`Places found for ${results.query}`}>
          {results.places.map((place) => (
            <li key={place.id}>
              <button
                type="button"
                onClick={() => handlePick(place)}
                disabled={disabled}
                className="w-full text-left flex items-start gap-3 rounded-xl border border-base-300 bg-base-100 px-4 py-3 hover:border-primary hover:bg-primary/5 transition-colors"
              >
                {place.kind ? (
                  <HospitalIcon weight="duotone" className="w-5 h-5 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <MapPinIcon weight="regular" className="w-5 h-5 mt-0.5 shrink-0 text-base-content/50" aria-hidden="true" />
                )}
                <span className="min-w-0">
                  <span className="block font-semibold text-base-content wrap-anywhere">
                    {place.kind && <span className="sr-only">{place.kind}: </span>}
                    {place.name}
                  </span>
                  {place.addressLine && (
                    <span className="block text-sm text-base-content/60 wrap-anywhere">{place.addressLine}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Nominatim's usage policy asks for this attribution next to the results */}
      <p id={HELP_ID} className="text-xs text-base-content/60 mt-2 leading-relaxed">
        Search by OpenStreetMap Nominatim, which receives what you type. Data ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" className="underline">
          OpenStreetMap contributors
        </a>
        .
      </p>

      {location && (
        <motion.div
          ref={confirmationRef}
          tabIndex={-1}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-3 rounded-xl border border-success/20 bg-success/5 p-3 space-y-3"
        >
          <div className="flex items-start gap-2">
            <CheckCircleIcon weight="fill" className="w-5 h-5 text-success shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0 text-sm">
              <div className="font-semibold text-base-content">Hospital location set</div>
              {location.source === 'search' ? (
                <>
                  <div className="text-base-content/80 wrap-anywhere">{location.name}</div>
                  {location.addressLine && <div className="text-base-content/70 wrap-anywhere">{location.addressLine}</div>}
                </>
              ) : (
                <div className="text-base-content/70">Where this device was when you chose “I'm at the hospital”.</div>
              )}
            </div>
          </div>
          {/* key: Leaflet reads the centre only when the map is created, so a new place needs a new map */}
          <MapErrorBoundary height="h-37.5" note="The hospital location is still set.">
            <Suspense
              fallback={
                <div className="h-37.5 flex items-center justify-center">
                  <span className="loading loading-spinner text-primary"></span>
                </div>
              }
            >
              <DonorMap
                key={`${location.coordinates[0]},${location.coordinates[1]}`}
                hospitalLocation={location.coordinates}
                interactive={false}
                height="h-37.5"
              />
            </Suspense>
          </MapErrorBoundary>
        </motion.div>
      )}

      <div className="divider text-xs text-base-content/40 my-2">or</div>
      <button
        type="button"
        className="btn btn-sm btn-outline w-full sm:w-auto h-auto whitespace-normal py-2 rounded-xl font-semibold border-base-300 hover:border-primary hover:bg-primary/5 hover:text-primary active:scale-98 transition-all"
        onClick={handleUseDeviceLocation}
        disabled={disabled}
        aria-describedby={DEVICE_NOTE_ID}
      >
        <MapPinIcon weight="regular" className="w-4 h-4 shrink-0" aria-hidden="true" />
        I'm at the hospital – use my location
      </button>
      <p id={DEVICE_NOTE_ID} className="text-xs text-base-content/60 mt-1.5 leading-relaxed">
        This shares where your device is right now, so use it only at the hospital.
      </p>
    </div>
  );
};

export default HospitalLocationField;
