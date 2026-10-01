import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { MapPinIcon, UserIcon, EnvelopeSimpleIcon, LockIcon, DropIcon, EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import { useAuthStore } from '../store/useAuthStore';
import toast from 'react-hot-toast';
import PrivacySummary from '../components/PrivacySummary';
import PrivacyConsentFields from '../components/PrivacyConsentFields';
import { findMissingConsentErrors } from '../lib/privacyConsent';
import { DEVICE_LOCATION_OPTIONS, describeDeviceLocationError } from '../lib/deviceLocation';
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, describePlaceSearchError, normalisePlaceQuery } from '../lib/nominatim';
import { usePlaceSearch } from '../lib/usePlaceSearch';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
// Prefix of the two consent checkboxes' ids, so the first one left unticked can be focused
const CONSENT_ID_PREFIX = 'register';

const RegisterPage = () => {
  const { register } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    bloodGroup: '',
    location: null, // [lng, lat]
    // The two separate agreements, both unticked until the user ticks them; sent as booleans
    acceptPrivacy: false,
    confirmAdult: false,
  });

  const [errors, setErrors] = useState({});
  const [placeQuery, setPlaceQuery] = useState('');
  const { search: searchPlace, isSearching: isPlaceSearching, isSearchBlocked: isPlaceSearchBlocked } = usePlaceSearch();
  // Each press of the location button takes the next number, and a position or error that arrives
  // for an older press is dropped. A search that sets the location moves the number on, so a slow
  // position never replaces a place found later.
  const deviceRequestRef = useRef(0);
  const isDeviceRequestPendingRef = useRef(false);

  // Leaving the page (e.g. signed up while a position was still on its way) drops that answer and
  // its "Fetching location..." message, which would otherwise show up on the next page
  useEffect(() => () => {
    deviceRequestRef.current += 1;
    if (isDeviceRequestPendingRef.current) toast.dismiss('geo');
  }, []);

  const handleConsentChange = (name, checked) => {
    setFormData((prev) => ({ ...prev, [name]: checked }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: '' }));
  };

  const handleEmailBlur = () => {
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(formData.email)) {
      setErrors(prev => ({ ...prev, email: 'Please enter a valid email address (e.g. name@domain.com)' }));
    } else {
      setErrors(prev => ({ ...prev, email: '' }));
    }
  };

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by your browser');
      return;
    }
    
    const requestId = ++deviceRequestRef.current;
    isDeviceRequestPendingRef.current = true;
    toast.loading('Fetching location...', { id: 'geo' });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (requestId !== deviceRequestRef.current) return;
        isDeviceRequestPendingRef.current = false;
        // From the latest form, not this render's: the position can take seconds, and the user
        // may tick a checkbox or type meanwhile
        setFormData((prev) => ({
          ...prev,
          location: [position.coords.longitude, position.coords.latitude],
        }));
        toast.success('Location captured successfully!', { id: 'geo' });
      },
      (error) => {
        if (requestId !== deviceRequestRef.current) return;
        isDeviceRequestPendingRef.current = false;
        console.error('Device location failed:', error);
        toast.error(`${describeDeviceLocationError(error)} Or search for your area instead.`, { id: 'geo' });
      },
      DEVICE_LOCATION_OPTIONS,
    );
  };

  // Only the first match is used, so only one is asked for (lib/nominatim.js)
  const handlePlaceSearch = async () => {
    // Its "Searching..." message is already up, and its answer replaces it
    if (isPlaceSearching) return;
    const query = normalisePlaceQuery(placeQuery);
    if (query.length < MIN_QUERY_LENGTH) {
      toast.error(`Type at least ${MIN_QUERY_LENGTH} letters of a place name`, { id: 'geoSearch' });
      return;
    }
    // A press of the location button while this search runs is the later choice
    const deviceRequestAtStart = deviceRequestRef.current;
    toast.loading('Searching...', { id: 'geoSearch' });
    try {
      const places = await searchPlace(query, { limit: 1 });
      // null: a search started in the same moment is already running, and its answer replaces the message
      if (places === null) return;
      if (deviceRequestRef.current !== deviceRequestAtStart) {
        toast.dismiss('geoSearch');
        return;
      }
      if (places.length > 0) {
        // Drops a position still on its way from an earlier press of the location button
        deviceRequestRef.current += 1;
        isDeviceRequestPendingRef.current = false;
        toast.dismiss('geo');
        // From the latest form, as in handleGetLocation
        setFormData((prev) => ({ ...prev, location: places[0].coordinates }));
        toast.success(`Location found: ${places[0].name}`, { id: 'geoSearch' });
      } else {
        toast.error('No place in India matches that. Try another name.', { id: 'geoSearch' });
      }
    } catch (searchError) {
      const message = describePlaceSearchError(searchError);
      if (!message) {
        toast.dismiss('geoSearch');
        return;
      }
      // 'too_soon': nothing was sent, since the wait after the last search isn't over; the
      // message says so, and it isn't a failure worth logging
      if (searchError?.code !== 'too_soon') console.error('Place search failed:', searchError);
      toast.error(message, { id: 'geoSearch' });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrors({});
    
    if (formData.email && !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(formData.email)) {
      setErrors(prev => ({ ...prev, email: 'Please enter a valid email address (e.g. name@domain.com)' }));
      return;
    }
    // Both boxes must be ticked; shown together with a missing location so one submit finds both
    const missingConsentErrors = findMissingConsentErrors(formData);
    if (!formData.location) {
      setErrors(prev => ({ ...prev, location: 'Please provide your location to help match you with nearby emergencies.', ...missingConsentErrors }));
      toast.error('Please provide your location to help match you with nearby emergencies.');
      return;
    }
    const firstMissingConsent = Object.keys(missingConsentErrors)[0];
    if (firstMissingConsent) {
      setErrors(prev => ({ ...prev, ...missingConsentErrors }));
      document.getElementById(`${CONSENT_ID_PREFIX}-${firstMissingConsent}`)?.focus();
      return;
    }
    setLoading(true);
    const result = await register(formData);
    if (result && result.errors) {
      setErrors(result.errors);
    }
    setLoading(false);
  };

  // Stagger delay helper
  const fieldDelay = (i) => ({ delay: 0.15 + i * 0.07, duration: 0.4 });

  return (
    <div className="flex justify-center items-center py-12 px-4">
      <motion.div 
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
        className="card w-full max-w-md bg-base-100 shadow-2xl shadow-base-content/5 border border-base-300 rounded-3xl overflow-hidden"
      >
        <div className="card-body p-8 sm:p-10">
          {/* Header */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.4 }}
            className="text-center mb-8"
          >
            <div className="w-14 h-14 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-5">
              <DropIcon weight="duotone" className="w-7 h-7" />
            </div>
            <h2 className="text-3xl font-display font-extrabold text-base-content tracking-tight">Create Account</h2>
            <p className="text-base-content/50 mt-2 font-normal text-sm">Join Donor and start saving lives</p>
          </motion.div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Full Name */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(0)}
              className="form-control"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Full Name</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 z-10 pl-4 flex items-center pointer-events-none">
                  <UserIcon weight="regular" className="h-5 w-5 text-base-content/30" />
                </div>
                <input 
                  type="text" 
                  className={`input w-full pl-12 rounded-xl border ${errors.name ? 'border-error focus:border-error focus:ring-error' : 'border-base-300 focus:border-primary focus:ring-primary'} bg-base-100 shadow-sm focus:ring-1 transition-all text-base`}
                  placeholder="John Doe"
                  required
                  value={formData.name}
                  onChange={(e) => {
                    setFormData({ ...formData, name: e.target.value });
                    if (errors.name) setErrors(prev => ({ ...prev, name: '' }));
                  }}
                />
              </div>
              {errors.name && (
                <motion.span 
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-error text-sm mt-1.5 ml-1 font-medium"
                >
                  {errors.name}
                </motion.span>
              )}
            </motion.div>

            {/* Email */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(1)}
              className="form-control"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Email</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 z-10 pl-4 flex items-center pointer-events-none">
                  <EnvelopeSimpleIcon weight="regular" className="h-5 w-5 text-base-content/30" />
                </div>
                <input 
                  type="email" 
                  inputMode="email"
                  className={`input w-full pl-12 rounded-xl border ${errors.email ? 'border-error focus:border-error focus:ring-error' : 'border-base-300 focus:border-primary focus:ring-primary'} bg-base-100 shadow-sm focus:ring-1 transition-all text-base`}
                  placeholder="you@example.com"
                  required
                  value={formData.email}
                  onChange={(e) => {
                    setFormData({ ...formData, email: e.target.value });
                    if (errors.email) setErrors(prev => ({ ...prev, email: '' }));
                  }}
                  onBlur={handleEmailBlur}
                />
              </div>
              {errors.email && (
                <motion.span 
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-error text-sm mt-1.5 ml-1 font-medium"
                >
                  {errors.email}
                </motion.span>
              )}
            </motion.div>

            {/* Password */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(2)}
              className="form-control"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Password</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 z-10 pl-4 flex items-center pointer-events-none">
                  <LockIcon weight="regular" className="h-5 w-5 text-base-content/30" />
                </div>
                <input 
                  type={showPassword ? "text" : "password"}
                  className={`input w-full pl-12 pr-12 rounded-xl border ${errors.password ? 'border-error focus:border-error focus:ring-error' : 'border-base-300 focus:border-primary focus:ring-primary'} bg-base-100 shadow-sm focus:ring-1 transition-all text-base`} 
                  placeholder="••••••••"
                  required
                  minLength={6}
                  value={formData.password}
                  onChange={(e) => {
                    setFormData({ ...formData, password: e.target.value });
                    if (errors.password) setErrors(prev => ({ ...prev, password: '' }));
                  }}
                />
                <button 
                  type="button"
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-base-content/30 hover:text-primary transition-colors focus:outline-none"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeSlashIcon weight="regular" className="h-5 w-5" /> : <EyeIcon weight="regular" className="h-5 w-5" />}
                </button>
              </div>
              {errors.password ? (
                <motion.span 
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-error text-sm mt-1.5 ml-1 font-medium"
                >
                  {errors.password}
                </motion.span>
              ) : (
                <span className="text-base-content/40 text-xs mt-1.5 ml-1">At least 6 characters</span>
              )}
            </motion.div>

            {/* Blood Group */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(3)}
              className="form-control"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Blood Group</span></label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 z-10 pl-4 flex items-center pointer-events-none">
                  <DropIcon weight="regular" className="h-5 w-5 text-primary/50" />
                </div>
                <select 
                  className={`select w-full pl-12 rounded-xl border ${errors.bloodGroup ? 'border-error focus:border-error focus:ring-error' : 'border-base-300 focus:border-primary focus:ring-primary'} bg-base-100 shadow-sm focus:ring-1 transition-all font-medium text-base`}
                  required
                  value={formData.bloodGroup}
                  onChange={(e) => {
                    setFormData({ ...formData, bloodGroup: e.target.value });
                    if (errors.bloodGroup) setErrors(prev => ({ ...prev, bloodGroup: '' }));
                  }}
                >
                  <option value="" disabled>Select your blood group</option>
                  {BLOOD_GROUPS.map((bg) => (
                    <option key={bg} value={bg}>{bg}</option>
                  ))}
                </select>
              </div>
              {errors.bloodGroup && (
                <motion.span 
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-error text-sm mt-1.5 ml-1 font-medium"
                >
                  {errors.bloodGroup}
                </motion.span>
              )}
            </motion.div>

            {/* Location */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(4)}
              className="form-control mt-2"
            >
              <label className="label"><span className="label-text font-semibold text-base-content/70 text-xs uppercase tracking-wider">Location</span></label>
              {/* Read before the browser asks for location access, which only the button below triggers */}
              <p id="register-location-help" className="text-xs text-base-content/60 leading-relaxed mb-3">
                Used to match you with blood requests within 15 km. Other users never see your exact location; anyone
                with a Donor account who asks for blood near you can see it rounded to about 1 km, without your name.
                Search sends the place you type to OpenStreetMap.
              </p>
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  className={`btn w-full rounded-xl font-bold border-2 transition-all active:scale-98 ${formData.location ? 'btn-success text-white border-success' : 'btn-outline border-base-300 hover:border-primary hover:bg-primary/5 hover:text-primary'}`}
                  onClick={handleGetLocation}
                  aria-describedby="register-location-help"
                >
                  <MapPinIcon weight={formData.location ? "fill" : "regular"} className="w-5 h-5 mr-2" />
                  {formData.location ? 'Location Captured ✓' : 'Click to Get Current Location'}
                </button>

                <div className="divider text-xs text-base-content/40 my-0 uppercase">Or Enter Manually</div>

                <div className="flex gap-2">
                  <input 
                    type="search" 
                    id="manual-location-input"
                    enterKeyHint="search"
                    autoComplete="off"
                    maxLength={MAX_QUERY_LENGTH}
                    placeholder="E.g. Salt Lake, Kolkata" 
                    aria-label="Search for your area"
                    aria-describedby="register-place-search-credit"
                    className="input w-full rounded-xl border border-base-300 bg-base-100 shadow-sm focus:border-primary focus:ring-1 focus:ring-primary transition-all text-base"
                    value={placeQuery}
                    onChange={(e) => setPlaceQuery(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter searches instead of sending the sign-up form; an input method's
                      // composition (e.g. Hindi typing) keeps its own Enter
                      if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                      e.preventDefault();
                      handlePlaceSearch();
                    }}
                  />
                  <button 
                    type="button" 
                    className="btn btn-secondary rounded-xl font-bold active:scale-98 transition-transform"
                    onClick={handlePlaceSearch}
                    disabled={isPlaceSearchBlocked}
                  >
                    Search
                  </button>
                </div>
                {/* Nominatim's usage policy asks for this attribution next to the search */}
                <p id="register-place-search-credit" className="text-xs text-base-content/60 leading-relaxed">
                  Search by OpenStreetMap Nominatim. Data ©{' '}
                  <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" className="underline">
                    OpenStreetMap contributors
                  </a>
                  .
                </p>
              </div>
              {formData.location ? (
                <motion.span 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-xs font-semibold text-success mt-3 text-center"
                >
                  Coordinates: {formData.location[0].toFixed(4)}, {formData.location[1].toFixed(4)}
                </motion.span>
              ) : errors.location && (
                <motion.span 
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-error text-sm mt-1.5 text-center font-medium"
                >
                  {errors.location}
                </motion.span>
              )}
            </motion.div>

            {/* Privacy summary and the two agreements, above the button that creates the account */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(5)}
              className="space-y-4 pt-4"
            >
              <PrivacySummary />
              <PrivacyConsentFields
                idPrefix={CONSENT_ID_PREFIX}
                values={formData}
                errors={errors}
                onChange={handleConsentChange}
              />
            </motion.div>

            {/* Submit */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={fieldDelay(6)}
              className="form-control mt-8"
            >
              <button type="submit" className="btn btn-primary w-full rounded-xl text-white font-bold shadow-lg shadow-primary/20 border-none h-14 text-lg active:scale-98 transition-transform" disabled={loading}>
                {loading ? <span className="loading loading-spinner"></span> : 'Create Account'}
              </button>
            </motion.div>
          </form>

          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.65, duration: 0.4 }}
            className="text-center mt-8"
          >
            <p className="text-base-content/50 text-sm font-medium">
              Already have an account?{' '}
              <Link to="/login" className="text-primary font-bold hover:underline">Log in</Link>
            </p>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
};

export default RegisterPage;
