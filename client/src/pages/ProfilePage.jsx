import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { axiosInstance } from '../lib/axios';
import { getSocket, hasSocketConnectedBefore, hadFailedAttempt } from '../lib/socket';
import toast from 'react-hot-toast';
import { UserCircleIcon, ClockClockwiseIcon, MapTrifoldIcon, CheckCircleIcon, HourglassMediumIcon, WarningIcon, WarningOctagonIcon, TrashIcon, ShieldCheckIcon, ProhibitIcon } from '@phosphor-icons/react';
import { PRIVACY_CONTACT_EMAIL } from '../config/privacy';
import StatsCard from '../components/StatsCard';
import StarRating from '../components/StarRating';
import DeleteAccountDialog from '../components/DeleteAccountDialog';
import {
  DONATION_GAP_DAYS,
  isInDonationGap,
  formatIndiaDate,
  getTodayInIndiaDateString,
  toDateInputValue,
} from '../lib/donationGap';
import { isExpiredRequest } from '../lib/requestExpiry';
import { isReportedRequest, REPORTED_NOTE } from '../lib/reportedRequest';
import { buildRepostState } from '../lib/repostRequest';
import { DEVICE_LOCATION_OPTIONS, describeDeviceLocationError } from '../lib/deviceLocation';

// The loading, success and error messages of one press of the location button share this id
const DEVICE_TOAST_ID = 'geo';

// Re-reads when this donor may donate again, e.g. after a donation is marked fulfilled while this
// page is open. Not checkAuth: a failed checkAuth sets authUser to null, and ProtectedRoute would
// then send the donor to /login over a network blip. Only the latest call's answer is applied, so
// a slow earlier response cannot put back an older date. It is also dropped if authUser was
// replaced while it was on the way (Save's checkAuth, a sign-in, or another refresh that changed
// the date), since that newer copy may already hold a later date. An unchanged date keeps the
// same authUser object, so a refresh that changed nothing does not cause the next one to be dropped.
let latestEligibilityRefreshId = 0;
const refreshNextEligibleDonationAt = async () => {
  latestEligibilityRefreshId += 1;
  const refreshId = latestEligibilityRefreshId;
  const authUserAtStart = useAuthStore.getState().authUser;
  try {
    const res = await axiosInstance.get('/auth/check');
    const { authUser, setNextEligibleDonationAt } = useAuthStore.getState();
    // The id check: the cookie may belong to someone else by now, after a sign-in elsewhere in this browser
    if (
      refreshId === latestEligibilityRefreshId &&
      authUser === authUserAtStart &&
      res.data.user._id === authUserAtStart?._id
    ) {
      setNextEligibleDonationAt(res.data.user.nextEligibleDonationAt ?? null);
    }
  } catch (error) {
    // 401 just means the session ended; the next page load handles that
    if (error.response?.status !== 401) {
      console.error('Error refreshing donation eligibility:', error);
    }
  }
};

// Saving an outside donation is never refused, but a donor who gave blood elsewhere while holding
// an accepted request can no longer make that donation, and the requester is counting on it.
// With an accepted request, accept's checks leave no in-app donation inside the gap, so being in
// the gap right after this save means the outside date put them there.
const warnIfOutsideDonationDuringActiveDonation = async (savedUser, previousOutsideDonationDate) => {
  const savedOutsideDonationDate = toDateInputValue(savedUser?.lastOutsideDonationDate);
  const isNewOutsideDonationInGap =
    Boolean(savedOutsideDonationDate) &&
    savedOutsideDonationDate !== previousOutsideDonationDate &&
    isInDonationGap(savedUser.nextEligibleDonationAt);
  if (!isNewOutsideDonationInGap) return;

  try {
    // The incoming-requests response already reports hasActiveDonation; only fetched in this rare case
    const res = await axiosInstance.get('/requests/incoming');
    if (res.data.hasActiveDonation) {
      // This popup is white in both themes, and the dark theme's warning yellow is faint on white.
      // warning-content is the same deep amber in both themes.
      toast(
        <span>
          You have an active donation. Please tell the requester you donated on{' '}
          <span className="whitespace-nowrap">{formatIndiaDate(savedUser.lastOutsideDonationDate)}</span>.
        </span>,
        { icon: <WarningIcon weight="fill" className="w-5 h-5 text-warning-content shrink-0" />, duration: 10000 }
      );
    }
  } catch (error) {
    // The profile is already saved and confirmed, so only log it
    console.error('Error checking for an active donation:', error);
  }
};

/**
 * The people this user blocked (GET /users/blocks), each with Unblock. The server sends a first
 * name, the date and the block's own id, never the other person's id. Blocking happens on the
 * dashboard (components/ReportBlockDialog.jsx); this is the only place to undo it.
 */
const BlockedUsersSection = () => {
  const headingRef = useRef(null);
  // null while loading; false when the load failed
  const [blockedUsers, setBlockedUsers] = useState(null);
  const [unblockingId, setUnblockingId] = useState(null);

  useEffect(() => {
    let isCurrent = true;
    axiosInstance
      .get('/users/blocks')
      .then((res) => {
        if (isCurrent) setBlockedUsers(res.data.blockedUsers);
      })
      .catch((error) => {
        console.error('Error loading blocked users:', error);
        if (isCurrent) setBlockedUsers(false);
      });
    return () => {
      isCurrent = false;
    };
  }, []);

  // The row and its button go, so focus moves back to the top of this part of the page
  const removeEntry = (entry) => {
    setBlockedUsers((prev) => prev.filter((blocked) => blocked._id !== entry._id));
    headingRef.current?.focus();
  };

  const handleUnblock = async (entry) => {
    setUnblockingId(entry._id);
    try {
      await axiosInstance.delete(`/users/blocks/${entry._id}`);
      removeEntry(entry);
      toast.success(`Unblocked ${entry.name}`);
    } catch (error) {
      // 404: already unblocked, from another window or device
      if (error.response?.status === 404) removeEntry(entry);
      toast.error(error.response?.data?.message || "Couldn't unblock. Please try again.");
    } finally {
      setUnblockingId(null);
    }
  };

  return (
    <section aria-labelledby="blocked-users-heading" className="bg-base-100 rounded-3xl p-6 md:p-8 shadow-sm border border-base-300">
      <h2
        ref={headingRef}
        id="blocked-users-heading"
        tabIndex={-1}
        className="text-xl font-display font-bold mb-2 flex items-center gap-2 focus:outline-none"
      >
        <ProhibitIcon weight="duotone" className="w-6 h-6 text-primary shrink-0" aria-hidden="true" />
        Blocked users
      </h2>
      <p className="text-sm text-base-content/70 leading-relaxed mb-5 max-w-prose">
        You aren't matched with people you block, and they aren't told. Unblock someone to be matched with them again.
      </p>

      {blockedUsers === null ? (
        <div className="flex justify-center p-4">
          <span className="loading loading-spinner text-primary" aria-label="Loading blocked users"></span>
        </div>
      ) : blockedUsers === false ? (
        <p role="alert" className="text-sm font-medium text-error">
          Your blocked users couldn't be loaded. Reload the page to try again.
        </p>
      ) : blockedUsers.length === 0 ? (
        <div className="text-center p-6 bg-base-200/50 rounded-2xl text-base-content/60">
          You haven't blocked anyone.
        </div>
      ) : (
        <ul className="space-y-3">
          {blockedUsers.map((entry) => (
            <li key={entry._id} className="bg-base-200 rounded-2xl p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-bold wrap-anywhere">{entry.name}</div>
                {/* The day in India, wherever the browser is */}
                <div className="text-sm text-base-content/60">
                  Blocked on <span className="whitespace-nowrap">{formatIndiaDate(entry.blockedAt)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleUnblock(entry)}
                disabled={unblockingId !== null}
                aria-label={`Unblock ${entry.name}`}
                className="btn btn-sm btn-outline rounded-xl shrink-0 min-h-11"
              >
                {unblockingId === entry._id ? <span className="loading loading-spinner loading-xs" aria-hidden="true"></span> : 'Unblock'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const ProfilePage = () => {
  const { authUser, checkAuth } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState({ pastRequests: [], pastDonations: [] });

  const [formData, setFormData] = useState({
    name: authUser?.name || '',
    bloodGroup: authUser?.bloodGroup || 'A+',
    isAvailable: authUser?.isAvailable ?? true,
    location: authUser?.location?.coordinates || null,
    // YYYY-MM-DD while editing; '' means no outside donation
    lastOutsideDonationDate: toDateInputValue(authUser?.lastOutsideDonationDate),
  });

  // From the saved profile (authUser), not the unsaved date field, so it matches what the server enforces
  const nextEligibleDonationAt = authUser?.nextEligibleDonationAt;
  const isResting = isInDonationGap(nextEligibleDonationAt);

  const [locating, setLocating] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  // Each press of the location button takes the next number, and a position or error that arrives
  // for an older one is dropped. Leaving the page moves the number on, as on the sign-up page.
  const deviceRequestRef = useRef(0);
  const isDeviceRequestPendingRef = useRef(false);

  // Leaving the page drops a position still on its way, and its "Fetching location..." message,
  // which would otherwise stay up on the next page
  useEffect(() => () => {
    deviceRequestRef.current += 1;
    if (isDeviceRequestPendingRef.current) toast.dismiss(DEVICE_TOAST_ID);
  }, []);

  useEffect(() => {
    const fetchProfileData = async () => {
      // A donation may have been fulfilled since authUser was last loaded. Outside the
      // Promise.all: it handles its own errors and must not turn into "Failed to load".
      refreshNextEligibleDonationAt();
      try {
        const [statsRes, historyRes] = await Promise.all([
          axiosInstance.get('/users/stats'),
          axiosInstance.get('/users/history'),
        ]);
        setStats(statsRes.data);
        setHistory(historyRes.data);
      } catch {
        toast.error('Failed to load profile data');
      }
    };
    fetchProfileData();
  }, []);

  // A donation marked fulfilled while this page is open starts the donation gap, which only the
  // server can date. Registered once and removed on unmount, like the dashboard's listener.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleStatusUpdate = (data) => {
      if (data.status === 'fulfilled') refreshNextEligibleDonationAt();
    };

    // A fulfil sent while the socket was down is never replayed, so re-read the date on every
    // connect after this socket's first, and on a first connect that followed failed attempts.
    // Same rule as the dashboard's reconnect handler.
    let hasConnectedBefore = hasSocketConnectedBefore(socket);
    const handleConnect = () => {
      const shouldRefresh = hasConnectedBefore || hadFailedAttempt(socket);
      hasConnectedBefore = true;
      if (shouldRefresh) refreshNextEligibleDonationAt();
    };

    socket.on('requestStatusUpdate', handleStatusUpdate);
    socket.on('connect', handleConnect);

    return () => {
      socket.off('requestStatusUpdate', handleStatusUpdate);
      socket.off('connect', handleConnect);
    };
  }, []);

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!formData.location) {
      toast.error('Location is required');
      return;
    }
    setLoading(true);
    // As saved before this change, so only a newly entered date can bring the warning below
    const previousOutsideDonationDate = toDateInputValue(authUser?.lastOutsideDonationDate);
    try {
      // An empty date field clears the date: the server takes null for that, not ''
      const res = await axiosInstance.patch('/users/profile', {
        ...formData,
        lastOutsideDonationDate: formData.lastOutsideDonationDate || null,
      });
      await checkAuth(); // Refresh user in context
      // A fulfil that lands while checkAuth is in flight is lost from the status line otherwise
      refreshNextEligibleDonationAt();
      toast.success('Profile updated successfully!');
      // Not awaited: it handles its own errors, and Save need not wait for it
      warnIfOutsideDonationDuringActiveDonation(res.data.user, previousOutsideDonationDate);
    } catch (error) {
      // A rejected field (e.g. a future date) says what is wrong; the top-level message only says "Validation failed"
      const fieldErrors = error.response?.data?.errors;
      const firstFieldError = fieldErrors && Object.values(fieldErrors)[0];
      toast.error(firstFieldError || error.response?.data?.message || 'Update failed');
    } finally {
      setLoading(false);
    }
  };

  const getLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by your browser');
      return;
    }
    const requestId = ++deviceRequestRef.current;
    isDeviceRequestPendingRef.current = true;
    setLocating(true);
    toast.loading('Fetching location...', { id: DEVICE_TOAST_ID });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (requestId !== deviceRequestRef.current) return;
        isDeviceRequestPendingRef.current = false;
        // From the latest form, not this render's: the position can take seconds, and the user
        // may edit another field meanwhile
        setFormData((prev) => ({
          ...prev,
          location: [position.coords.longitude, position.coords.latitude],
        }));
        setLocating(false);
        toast.success('Location updated', { id: DEVICE_TOAST_ID });
      },
      (error) => {
        if (requestId !== deviceRequestRef.current) return;
        isDeviceRequestPendingRef.current = false;
        setLocating(false);
        console.error('Device location failed:', error);
        toast.error(describeDeviceLocationError(error), { id: DEVICE_TOAST_ID });
      },
      DEVICE_LOCATION_OPTIONS,
    );
  };

  return (
    <div className="space-y-8">
      <div className="bg-base-100 rounded-3xl p-6 md:p-8 shadow-sm border border-base-300">
        <h1 className="text-2xl font-display font-bold mb-6 flex items-center gap-2">
          <UserCircleIcon weight="duotone" className="w-8 h-8 text-primary" />
          Edit Profile
        </h1>
        
        <form onSubmit={handleUpdate} className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-base-content/70">Full Name</label>
            <input 
              type="text" 
              className="input w-full rounded-xl bg-base-200" 
              value={formData.name}
              onChange={e => setFormData({...formData, name: e.target.value})}
              required 
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold text-base-content/70">Blood Group</label>
            <select 
              className="select w-full rounded-xl bg-base-200"
              value={formData.bloodGroup}
              onChange={e => setFormData({...formData, bloodGroup: e.target.value})}
            >
              {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map(bg => (
                <option key={bg} value={bg}>{bg}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="text-sm font-semibold text-base-content/70 flex justify-between items-center">
              <span>Location</span>
              {formData.location && <span className="text-success text-xs font-bold">✓ Location Set</span>}
            </label>
            <div className="flex gap-2">
              <div className="flex-1 input bg-base-200 rounded-xl flex items-center opacity-60">
                {formData.location ? `${formData.location[1].toFixed(4)}, ${formData.location[0].toFixed(4)}` : 'Not set'}
              </div>
              <button 
                type="button" 
                onClick={getLocation} 
                disabled={locating}
                className="btn btn-primary btn-outline rounded-xl"
              >
                {locating ? <span className="loading loading-spinner loading-sm"></span> : <MapTrifoldIcon weight="bold" className="w-5 h-5" />}
                {formData.location ? 'Update' : 'Get Location'}
              </button>
            </div>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="cursor-pointer label whitespace-normal bg-base-200 p-4 rounded-xl flex items-start gap-4">
              <input 
                type="checkbox" 
                className="toggle toggle-primary toggle-lg mt-1" 
                checked={formData.isAvailable}
                onChange={e => setFormData({...formData, isAvailable: e.target.checked})}
              />
              <div>
                <span className="label-text font-bold text-base block mb-1">Available to donate (notify me of nearby requests)</span>
                <span className="label-text-alt text-base-content/60 leading-relaxed block">
                  Your choice. Turn this off to stop new request alerts and donation reminders. While you have an active donation, you get no new alerts either way.
                </span>
              </div>
            </label>
          </div>

          <div className="md:col-span-2 bg-base-200 p-4 rounded-xl space-y-4">
            <div role="status" className="flex items-start gap-3">
              {isResting ? (
                <HourglassMediumIcon weight="duotone" className="w-6 h-6 text-warning shrink-0" />
              ) : (
                <CheckCircleIcon weight="duotone" className="w-6 h-6 text-success shrink-0" />
              )}
              <div className="min-w-0">
                <p className="font-bold">
                  {isResting ? (
                    <>You can donate again from <span className="whitespace-nowrap">{formatIndiaDate(nextEligibleDonationAt)}</span></>
                  ) : (
                    "You're eligible to donate"
                  )}
                </p>
                <p className="text-sm text-base-content/60 leading-relaxed">
                  Donors wait {DONATION_GAP_DAYS} days between whole blood donations, counted from your last one.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="last-outside-donation" className="text-sm font-semibold text-base-content/70 block">
                Last donated outside Donor
              </label>
              <div className="flex gap-2">
                <input
                  id="last-outside-donation"
                  type="date"
                  className="input flex-1 min-w-0 rounded-xl bg-base-100"
                  min="1900-01-01"
                  max={getTodayInIndiaDateString()}
                  value={formData.lastOutsideDonationDate}
                  onChange={e => setFormData({ ...formData, lastOutsideDonationDate: e.target.value })}
                  aria-describedby="last-outside-donation-help"
                />
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, lastOutsideDonationDate: '' })}
                  disabled={!formData.lastOutsideDonationDate}
                  className="btn btn-ghost rounded-xl"
                >
                  Clear
                </button>
              </div>
              <p id="last-outside-donation-help" className="text-xs text-base-content/60 leading-relaxed">
                Optional. A donation at a hospital or blood camp. Donations made through Donor are counted for you.
              </p>
            </div>
          </div>

          <div className="md:col-span-2 flex justify-end mt-4">
            <button type="submit" disabled={loading || locating} className="btn btn-primary rounded-xl px-8 text-white font-bold shadow-lg shadow-primary/20">
              {loading ? <span className="loading loading-spinner"></span> : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>

      {stats && <StatsCard donorStats={stats.donor} requesterStats={stats.requester} />}

      <div className="bg-base-100 rounded-3xl p-6 md:p-8 shadow-sm border border-base-300">
        <h2 className="text-xl font-display font-bold mb-6 flex items-center gap-2">
          <ClockClockwiseIcon weight="duotone" className="w-6 h-6 text-primary" />
          Donation History
        </h2>
        
        {history.pastDonations.length === 0 && history.pastRequests.length === 0 ? (
          <div className="text-center p-8 bg-base-200/50 rounded-2xl text-base-content/60">
            You don't have any completed donations or requests yet.
          </div>
        ) : (
          <div className="space-y-6">
            {history.pastDonations.length > 0 && (
              <div>
                <h3 className="font-bold text-sm text-base-content/60 uppercase tracking-wider mb-3">Past Donations</h3>
                <div className="space-y-3">
                  {history.pastDonations.map(req => (
                    <div key={req._id} className="bg-base-200 rounded-2xl p-4 flex flex-col sm:flex-row justify-between sm:items-center gap-4">
                      <div className="min-w-0">
                        <div className="font-bold wrap-anywhere">{req.hospitalName}</div>
                        {/* requesterId is null once the requester has deleted their account. The day is India's. */}
                        <div className="text-sm text-base-content/60">
                          For {req.requesterId?.name || 'Deleted user'} <span className="whitespace-nowrap">• {formatIndiaDate(req.fulfilledAt)}</span>
                        </div>
                      </div>
                      {req.rating ? (
                        <div className="bg-warning/10 px-3 py-2 rounded-xl flex items-center gap-2 shrink-0">
                          <StarRating rating={req.rating} size="w-4 h-4" />
                          <span className="text-sm font-bold text-warning">{req.rating}/5</span>
                        </div>
                      ) : (
                        <div className="text-xs text-base-content/40 bg-base-300 px-3 py-1 rounded-full shrink-0">Not rated</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {history.pastRequests.length > 0 && (
              <div>
                <h3 className="font-bold text-sm text-base-content/60 uppercase tracking-wider mb-3 mt-8">Past Requests Made</h3>
                <div className="space-y-3">
                  {history.pastRequests.map(req => (
                    <div key={req._id} className="bg-base-200 rounded-2xl p-4 flex flex-col sm:flex-row justify-between sm:items-center gap-4">
                      <div>
                        <div className="font-bold">{req.unitsNeeded} {req.unitsNeeded === 1 ? 'unit' : 'units'} of {req.bloodGroup}</div>
                        <div className="text-sm text-base-content/60">
                          {/* matchedDonorId is null once the donor has deleted their account */}
                          {req.status === 'fulfilled' && <>Donated by {req.matchedDonorId?.name || 'Deleted user'} </>}
                          <span className="whitespace-nowrap">{req.status === 'fulfilled' && '• '}{formatIndiaDate(req.createdAt)}</span>
                        </div>
                        {isReportedRequest(req) && <div className="text-sm text-base-content/60">{REPORTED_NOTE}</div>}
                      </div>
                      {isExpiredRequest(req) ? (
                        // Opens the New Request form filled in with this request's details, to send again
                        <div className="flex flex-wrap items-center gap-3 shrink-0">
                          <div className="badge badge-ghost">expired</div>
                          <Link
                            to="/create-request"
                            state={buildRepostState(req)}
                            className="btn btn-sm btn-outline btn-primary rounded-xl font-bold"
                          >
                            Post again
                          </Link>
                        </div>
                      ) : (
                        <div className={`badge ${req.status === 'fulfilled' ? 'badge-info text-white' : req.status === 'accepted' ? 'badge-success text-white' : 'badge-ghost'}`}>
                          {isReportedRequest(req) ? 'closed' : req.status}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <BlockedUsersSection />

      <section aria-labelledby="privacy-heading" className="bg-base-100 rounded-3xl p-6 md:p-8 shadow-sm border border-base-300">
        <h2 id="privacy-heading" className="text-xl font-display font-bold mb-2 flex items-center gap-2">
          <ShieldCheckIcon weight="duotone" className="w-6 h-6 text-primary shrink-0" aria-hidden="true" />
          Privacy
        </h2>
        <div className="text-sm text-base-content/70 leading-relaxed mb-5 max-w-prose space-y-2">
          {authUser?.privacyConsent && (
            <p>
              You agreed to the Privacy Notice (version {authUser.privacyConsent.version}) on{' '}
              <span className="whitespace-nowrap">{formatIndiaDate(authUser.privacyConsent.acceptedAt)}</span>.
            </p>
          )}
          <p>
            For a copy of your data, or to correct it, email{' '}
            <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className="font-semibold text-primary underline wrap-anywhere">
              {PRIVACY_CONTACT_EMAIL}
            </a>
            . Deleting your account below withdraws your consent.
          </p>
        </div>
        <Link to="/privacy" className="btn btn-outline rounded-xl">
          Read the Privacy Notice
        </Link>
      </section>

      <section aria-labelledby="delete-account-heading" className="bg-base-100 rounded-3xl p-6 md:p-8 shadow-sm border border-error/30">
        <h2 id="delete-account-heading" className="text-xl font-display font-bold mb-2 flex items-center gap-2 text-error">
          <WarningOctagonIcon weight="duotone" className="w-6 h-6 shrink-0" />
          Delete account
        </h2>
        <p className="text-sm text-base-content/70 leading-relaxed mb-5 max-w-prose">
          Erase your account for good, after confirming your password. Completed donations stay in the other person's
          history as "Deleted user".
        </p>
        <button type="button" onClick={() => setIsDeleteDialogOpen(true)} className="btn btn-error btn-outline rounded-xl">
          <TrashIcon weight="bold" className="w-5 h-5" />
          Delete account
        </button>
      </section>

      {isDeleteDialogOpen && <DeleteAccountDialog onClose={() => setIsDeleteDialogOpen(false)} />}
    </div>
  );
};

export default ProfilePage;
