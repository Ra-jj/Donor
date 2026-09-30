import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { axiosInstance } from '../lib/axios';
import { getSocket, hasSocketConnectedBefore, hadFailedAttempt } from '../lib/socket';
import toast from 'react-hot-toast';
import { UserCircleIcon, ClockClockwiseIcon, MapTrifoldIcon, CheckCircleIcon, HourglassMediumIcon, WarningIcon, WarningOctagonIcon, TrashIcon } from '@phosphor-icons/react';
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
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setFormData({ ...formData, location: [position.coords.longitude, position.coords.latitude] });
        setLocating(false);
        toast.success('Location updated');
      },
      () => {
        setLocating(false);
        toast.error('Unable to retrieve your location');
      }
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
                  Your choice. Turn this off to stop new request alerts. While you have an active donation, you get no new alerts either way.
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
            <button type="submit" disabled={loading} className="btn btn-primary rounded-xl px-8 text-white font-bold shadow-lg shadow-primary/20">
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
                      <div>
                        <div className="font-bold">{req.hospitalName}</div>
                        {/* requesterId is null once the requester has deleted their account */}
                        <div className="text-sm text-base-content/60">For {req.requesterId?.name || 'Deleted user'} • {new Date(req.fulfilledAt).toLocaleDateString()}</div>
                      </div>
                      {req.rating ? (
                        <div className="bg-warning/10 px-3 py-2 rounded-xl flex items-center gap-2">
                          <StarRating rating={req.rating} size="w-4 h-4" />
                          <span className="text-sm font-bold text-warning">{req.rating}/5</span>
                        </div>
                      ) : (
                        <div className="text-xs text-base-content/40 bg-base-300 px-3 py-1 rounded-full">Not rated</div>
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
                        <div className="font-bold">{req.unitsNeeded} units of {req.bloodGroup}</div>
                        <div className="text-sm text-base-content/60">
                          {/* matchedDonorId is null once the donor has deleted their account */}
                          {req.status === 'fulfilled' && <>Donated by {req.matchedDonorId?.name || 'Deleted user'} • </>}
                          {new Date(req.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                      <div className={`badge ${req.status === 'fulfilled' ? 'badge-info text-white' : req.status === 'accepted' ? 'badge-success text-white' : 'badge-ghost'}`}>
                        {req.status}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

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
