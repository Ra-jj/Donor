import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { axiosInstance } from '../lib/axios';
import { loadDonorMap, preloadDonorMapWhenIdle } from '../lib/loadDonorMap';
import { getSocket, hasSocketConnectedBefore, hadFailedAttempt } from '../lib/socket';
import toast from 'react-hot-toast';
import { m, AnimatePresence, LazyMotion, domMax } from 'motion/react';
import ChatWindow from '../components/ChatWindow';
import StatsCard from '../components/StatsCard';
import StarRating from '../components/StarRating';
import MapErrorBoundary from '../components/MapErrorBoundary';
import ShareRequestButtons from '../components/ShareRequestButtons';
import ReportBlockDialog from '../components/ReportBlockDialog';
import { isInDonationGap, formatIndiaDate } from '../lib/donationGap';
import {
  getClosesAtMs,
  hasRunOut,
  isExpiredRequest,
  describeTimeLeft,
  EXPIRED_NOTE,
} from '../lib/requestExpiry';
import { announceExpiredRequest, announceMissedExpiredRequests } from '../lib/expiredRequestPopups';
import { buildRepostState } from '../lib/repostRequest';
import { isReportedRequest, REPORTED_NOTE, describeReportedRequest } from '../lib/reportedRequest';
import { PlusIcon, BellRingingIcon, ClockClockwiseIcon, ChecksIcon, XCircleIcon, HandHeartIcon, StarIcon, CheckCircleIcon, DotsThreeIcon } from '@phosphor-icons/react';

const DonorMap = lazy(loadDonorMap);

// The small button that opens ReportBlockDialog, on an incoming card and in the chat header. Kept
// quiet on purpose: most people never need it. It looks 32 px wide, but its ::after reaches 8 px
// past its 1 px border on every side, so a finger has a 46 px target.
const ReportBlockButton = ({ onOpen }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onOpen(); }}
    aria-label="Report or block"
    aria-haspopup="dialog"
    title="Report or block"
    className="btn btn-ghost btn-sm btn-circle text-base-content/60 relative after:absolute after:-inset-2"
  >
    <DotsThreeIcon weight="bold" className="w-5 h-5" aria-hidden="true" />
  </button>
);

const MINUTE_MS = 60 * 1000;
// How long after the lists reload a card that left them is gone from the page (its exit animation
// takes 0.3 s)
const CARD_EXIT_MS = 500;
// setTimeout fires at once for any longer delay
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// Below lg the round "+" button floats over the lists, 24 px from the screen's right edge and 56 px
// wide, so its left edge is 80 px from that edge, while on a phone a card's content reaches to 37 px
// from it. The rows of full-width buttons on a requester's own cards stop 52 px short, so at every
// scroll position the "+" button passes beside them, 9 px clear (more on wider screens), instead of
// over their right ends.
const CLEAR_OF_ROUND_BUTTON = 'max-lg:pr-13';

// A state's colour goes in the fill and edge only, and its words in the page's text colour, as on
// the urgency pills: white or coloured words on these colours measured from 1.7:1 to 3.3:1 in one
// theme or the other. TINTED_BUTTON has a stronger edge and a hover; daisyUI's disabled look loses to
// these utilities, so a disabled button leaves them off.
const TINTED = {
  success: 'border bg-success/10 border-success/20 text-base-content',
  warning: 'border bg-warning/10 border-warning/20 text-base-content',
  info: 'border bg-info/10 border-info/20 text-base-content',
};
const TINTED_BUTTON = {
  success: 'bg-success/10 border-success/40 hover:bg-success/20 text-base-content',
  warning: 'bg-warning/10 border-warning/40 hover:bg-warning/20 text-base-content',
};

// The signed-in user's id now, through getState, so callbacks set up once still read the latest.
// A response is applied only while this is the id it was asked for: one that arrives after a
// sign-out and a sign-in as someone else belongs to the earlier user.
const getSignedInUserId = () => useAuthStore.getState().authUser?._id;

/** "Open for 31 more hours" on a requester's own pending request, kept current while it is shown */
const OpenTimeLeft = ({ createdAt }) => {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="text-xs text-base-content/60 font-medium mt-1">
      {describeTimeLeft(getClosesAtMs(createdAt), nowMs)}
    </p>
  );
};

/** Swipeable request card for mobile — drag right to accept, left to decline */
const SwipeableRequestCard = ({ req, onAccept, onDecline, onSelect, isSelected, canAccept, children }) => {
  const [dragX, setDragX] = useState(0);

  if (req.status !== 'pending') {
    // Non-pending cards are not swipeable
    return (
      <m.div
        layout
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.3, layout: { duration: 0.25 } }}
        onClick={() => req.status === 'accepted' && onSelect(req._id)}
        className={`card bg-base-100 shadow-md border overflow-hidden transition-colors ${
          req.status === 'accepted' ? 'cursor-pointer hover:border-primary' : 'border-base-200'
        } ${isSelected ? 'border-primary ring-2 ring-primary/50' : ''}`}
      >
        {children}
      </m.div>
    );
  }

  return (
    <m.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: dragX > 0 ? 200 : -200, scale: 0.9 }}
      transition={{ duration: 0.3, layout: { duration: 0.25 } }}
      className="relative"
    >
      {/* Swipe hints behind the card */}
      <div className="absolute inset-0 rounded-2xl flex items-center justify-between px-6 pointer-events-none">
        {/* The colour is in the icons; red or green words measured 4.4:1 and 3.2:1 in the light theme */}
        <div className={`flex items-center gap-2 text-base-content font-bold transition-opacity ${dragX < -30 ? 'opacity-100' : 'opacity-0'}`}>
          <XCircleIcon weight="fill" className="w-6 h-6 text-error" /> Decline
        </div>
        <div className={`flex items-center gap-2 text-base-content font-bold transition-opacity ${canAccept && dragX > 30 ? 'opacity-100' : 'opacity-0'}`}>
          Accept <ChecksIcon weight="fill" className="w-6 h-6 text-success" />
        </div>
      </div>

      <m.div
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        // A busy donor can still swipe left to decline, but the card will not move right
        dragElastic={canAccept ? 0.3 : { left: 0.3, right: 0 }}
        onDrag={(_, info) => setDragX(info.offset.x)}
        onDragEnd={(_, info) => {
          setDragX(0);
          // info.offset is the pointer's movement, not the card's, so check canAccept here too
          if (canAccept && info.offset.x > 100) {
            onAccept(req._id);
          } else if (info.offset.x < -100) {
            onDecline(req._id);
          }
        }}
        style={{ 
          x: 0,
          backgroundColor: canAccept && dragX > 30 ? 'rgba(22, 163, 74, 0.05)' : dragX < -30 ? 'rgba(220, 38, 38, 0.05)' : 'transparent'
        }}
        className="card bg-base-100 shadow-md border border-base-200 overflow-hidden cursor-grab active:cursor-grabbing rounded-2xl touch-pan-y"
      >
        <div className="h-1 w-full bg-error" />
        {children}
      </m.div>
    </m.div>
  );
};

const DashboardPage = () => {
  const { authUser } = useAuthStore();
  const [activeTab, setActiveTab] = useState('incoming');
  const [myRequests, setMyRequests] = useState([]);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [pushEnabled, setPushEnabled] = useState(!!authUser?.pushSubscription);
  const [stats, setStats] = useState(null);
  // Busy donor: already holds an accepted request, so Accept is disabled until it ends
  const [hasActiveDonation, setHasActiveDonation] = useState(false);
  // Resting donor: donated recently, so Accept is disabled until nextEligibleDonationAt. Kept on
  // authUser (refreshed by every incoming-requests load below) so Profile shows the same date.
  const nextEligibleDonationAt = authUser?.nextEligibleDonationAt;
  const isResting = isInDonationGap(nextEligibleDonationAt);
  const canAcceptRequests = !hasActiveDonation && !isResting;

  // Rating state — tracks which request is being rated
  const [ratingRequestId, setRatingRequestId] = useState(null);
  const [ratingValue, setRatingValue] = useState(0);
  const [ratingNote, setRatingNote] = useState('');
  const [ratingLoading, setRatingLoading] = useState(false);

  // The request ReportBlockDialog is open for, and the user's place on it, or null while it is closed
  const [reportBlockTarget, setReportBlockTarget] = useState(null);

  // A report or block can take away the card or chat whose button opened the dialog, and focus would
  // then fall to the page itself. It goes to the open list's heading instead.
  const incomingHeadingRef = useRef(null);
  const mineHeadingRef = useRef(null);
  const focusListHeadingIfLost = () => {
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    (activeTab === 'incoming' ? incomingHeadingRef : mineHeadingRef).current?.focus();
  };

  const enablePushNotifications = async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error('Notifications permission denied');
        return;
      }
      
      const registration = await navigator.serviceWorker.ready;
      
      const urlBase64ToUint8Array = (base64String) => {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
          outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
      };

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY)
      });

      await axiosInstance.post('/push/subscribe', subscription);
      setPushEnabled(true);
      toast.success('Push notifications enabled!');
    } catch (error) {
      console.error('Error enabling push:', error);
      toast.error('Failed to enable push notifications');
    }
  };

  // silent: refresh in place, without the full-page spinner that would remount ChatWindow
  // (losing the draft, focus and scroll). State is only set in the promise callbacks, once the
  // requests settle, so the mount effect below never sets state synchronously.
  // The answers are dropped if the signed-in user changed while they were on their way: a sign-out
  // and a sign-in as someone else would otherwise put this user's requests, popups and donation
  // date (kept on authUser, which outlives this page) into the next user's session.
  const fetchDashboardData = ({ silent = false } = {}) => {
    const userIdAtStart = getSignedInUserId();
    const isForAnotherUser = () => getSignedInUserId() !== userIdAtStart;
    return Promise.all([
      axiosInstance.get('/requests/mine'),
      axiosInstance.get('/requests/incoming'),
      axiosInstance.get('/users/stats'),
    ])
      .then(([mineRes, incomingRes, statsRes]) => {
        if (isForAnotherUser()) return;
        setMyRequests(mineRes.data.requests);
        // A request of theirs that closed after its open hours while they were away (the update over
        // the socket only reaches a page that is open) gets its popup now, once per device
        announceMissedExpiredRequests(userIdAtStart, mineRes.data.requests);
        setIncomingRequests(incomingRes.data.incomingRequests);
        setHasActiveDonation(Boolean(incomingRes.data.hasActiveDonation));
        // Through getState, a module-level reference, so this function (used by the effects
        // below that run once) depends on nothing that changes between renders
        useAuthStore.getState().setNextEligibleDonationAt(incomingRes.data.nextEligibleDonationAt ?? null);
        setStats(statsRes.data);

        // After a quiet refresh, a selected request that is no longer accepted has no chat,
        // so return to the list instead of the placeholder. A request is in only one list.
        if (silent) {
          const refreshed = [...mineRes.data.requests, ...incomingRes.data.incomingRequests];
          setSelectedRequestId((cur) => {
            if (!cur) return cur;
            const selected = refreshed.find((req) => req._id === cur);
            return selected && selected.status === 'accepted' ? cur : null;
          });
        }
      })
      .catch((error) => {
        // The earlier user's failed load is not the next user's problem
        if (isForAnotherUser()) return;
        console.error('Error fetching dashboard data:', error);
        toast.error('Failed to load dashboard');
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  };

  // Refetch behind the full-page spinner, for the action handlers. The first load does not
  // go through here: loading already starts true, so it has no spinner to turn on.
  const reloadDashboardData = () => {
    setLoading(true);
    return fetchDashboardData();
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  // Incoming requests show a map, and a new one can arrive over the socket at any time: load it
  // now, before a new build can replace it (lib/loadDonorMap.js)
  useEffect(() => preloadDonorMapWhenIdle(), []);

  // Listen for real-time new incoming requests
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleNewRequest = (newRequestData) => {
      toast.success(
        <div>
          <strong className="font-display text-lg tracking-tight">Emergency Request!</strong>
          <br/>
          {newRequestData.unitsNeeded} {newRequestData.unitsNeeded === 1 ? 'unit' : 'units'} of {newRequestData.bloodGroup} needed at {newRequestData.hospitalName}.
        </div>, 
        // wrap-anywhere: a hospital name with no spaces wraps inside the popup instead of running past it
        { duration: 6000, icon: '🚨', className: 'wrap-anywhere' }
      );
      // A request can be announced again once it is open again (its donor deleted their
      // account), so replace a card this donor may still hold for it rather than add a second
      setIncomingRequests((prev) => [newRequestData, ...prev.filter((req) => req._id !== newRequestData._id)]);
    };

    socket.on('newBloodRequest', handleNewRequest);

    return () => {
      socket.off('newBloodRequest', handleNewRequest);
    };
  }, []);

  // The status handler below is registered once, so it reads the latest list through this ref
  const myRequestsRef = useRef(myRequests);
  useEffect(() => {
    myRequestsRef.current = myRequests;
  }, [myRequests]);

  // Listen for real-time status updates on MY requests (e.g. someone accepted it)
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleStatusUpdate = (data) => {
      // Closed by the server: still pending when its open hours ran out. Only its requester is told.
      const hasExpired = data.status === 'cancelled' && data.reason === 'expired';
      // Closed by the server after reports from several users while it was open. Its requester is
      // told with the hospital's name; donors who could see it get only its id, and their card goes.
      const wasReported = data.status === 'cancelled' && data.reason === 'reported';

      // A late 'accepted' for a request that has already ended here must not revive it
      if (data.status === 'accepted') {
        const localRequest = myRequestsRef.current.find((req) => req._id === data.requestId);
        if (localRequest && ['cancelled', 'fulfilled'].includes(localRequest.status)) {
          return;
        }
      }

      if (data.status === 'accepted') {
        toast.success(`${data.donorName} accepted your request!`, { icon: '✅', duration: 5000 });
      } else if (data.status === 'fulfilled') {
        toast.success('Request has been marked as fulfilled! Thank you for donating. 🩸', { duration: 5000 });
      } else if (data.status === 'rated') {
        toast.success(`You received a ${data.rating}★ rating! ${data.ratingNote ? '"' + data.ratingNote + '"' : ''}`, { icon: '⭐', duration: 5000 });
      } else if (hasExpired) {
        const localRequest = myRequestsRef.current.find((req) => req._id === data.requestId);
        // One popup per request, however the update reaches this page, and recorded as shown so
        // the next load of the dashboard does not show it again
        announceExpiredRequest(
          useAuthStore.getState().authUser?._id,
          data.requestId,
          data.hospitalName || localRequest?.hospitalName
        );
      } else if (wasReported) {
        const localRequest = myRequestsRef.current.find((req) => req._id === data.requestId);
        if (localRequest) {
          toast.error(describeReportedRequest(data.hospitalName || localRequest.hospitalName), {
            id: `reported-${data.requestId}`,
            duration: 10000,
            className: 'wrap-anywhere',
          });
        }
      } else if (data.reason === 'blocked') {
        // This user's own block, made in another window or on another device: the lists below
        // change, and there is nothing to tell them
      } else if (data.status === 'cancelled' && data.reason === 'match_ended') {
        // The requester ended the match. Said without a reason, as the server sends none.
        toast.error("This request is no longer available to you. You're free to accept another.", { duration: 6000 });
      } else if (data.status === 'cancelled' && data.reason === 'account_deleted') {
        // The server sends no name for a deleted account
        toast.error('The requester deleted their account. This request is cancelled.', { duration: 6000 });
      } else if (data.status === 'cancelled') {
        toast.error(`${data.requesterName} cancelled their request`, { duration: 5000 });
      } else if (data.status === 'pending' && data.reason === 'account_deleted') {
        // Sent only when the matched donor deletes their account (deleteAccount on the server)
        toast.error('Your donor deleted their account. Your request is open to donors again.', { duration: 6000 });
      } else if (data.status === 'pending' && data.reason === 'donor_withdrew') {
        // The donor ended the match. Said without a reason, as the server sends none.
        toast.error('Your donor can no longer help. Your request is open to donors again.', { duration: 6000 });
      }
      
      // Update my requests list to reflect the new status. Back to pending, expired or reported means no donor.
      setMyRequests((prev) => prev.map(req => 
        req._id === data.requestId
          ? {
            ...req,
            status: data.status,
            matchedDonorId: data.status === 'pending' || hasExpired || wasReported ? null : 'temp_id',
            closedReason: hasExpired ? 'expired' : wasReported ? 'reported' : req.closedReason,
          }
          : req
      ));

      // Update incoming requests for the donor side. A cancelled request is gone for the
      // donor, so drop its card rather than keep it with a cancelled badge.
      setIncomingRequests((prev) => (data.status === 'cancelled'
        ? prev.filter((req) => req._id !== data.requestId)
        : prev.map(req =>
          req._id === data.requestId ? { ...req, status: data.status === 'rated' ? 'fulfilled' : data.status, rating: data.rating || req.rating, ratingNote: data.ratingNote || req.ratingNote } : req
        )));

      // Cancel and fulfil events only reach the matched donor, and a donor holds at most one
      // accepted request, so either one means this donor is no longer busy. An expiry goes to the
      // requester instead, and a close after reports to donors who only saw the request open: neither
      // says anything about their own donations.
      if ((data.status === 'cancelled' && !hasExpired && !wasReported) || data.status === 'fulfilled') {
        setHasActiveDonation(false);
      }

      // A cancelled, fulfilled, rated or reopened request has no chat, so close it if it is open.
      // Functional updater because this effect only runs once and cannot read selectedRequestId.
      if (['cancelled', 'fulfilled', 'rated', 'pending'].includes(data.status)) {
        setSelectedRequestId((cur) => (cur === data.requestId ? null : cur));
      }

      // A fulfilled donation starts this donor's donation gap, which only the server can date,
      // so reload quietly (stats included). Other changes only need fresh stats.
      if (data.status === 'fulfilled') {
        fetchDashboardData({ silent: true });
      } else {
        const userIdAtStart = getSignedInUserId();
        axiosInstance.get('/users/stats')
          .then((res) => {
            if (getSignedInUserId() === userIdAtStart) setStats(res.data);
          })
          .catch(() => {});
      }
    };

    // Events sent while this client was offline are not replayed, so refetch quietly on every
    // connect after this socket's first. 'connect' follows both the manager's own reconnects and
    // the manual retries in lib/socket.js (which fire no 'reconnect'), and it is the only
    // trigger here, so one reconnect refetches once.
    let hasConnectedBefore = hasSocketConnectedBefore(socket);
    // A first connect that followed failed attempts also refetches: events sent while those
    // attempts were failing were never delivered.
    const handleConnect = () => {
      const shouldRefetch = hasConnectedBefore || hadFailedAttempt(socket);
      hasConnectedBefore = true;
      if (shouldRefetch) fetchDashboardData({ silent: true });
    };

    socket.on('requestStatusUpdate', handleStatusUpdate);
    socket.on('connect', handleConnect);

    return () => {
      socket.off('requestStatusUpdate', handleStatusUpdate);
      socket.off('connect', handleConnect);
    };
  }, []);

  // A pending request closes REQUEST_OPEN_HOURS after it was created, and the server may be asleep
  // at that moment. So when the next one runs out on this screen: a donor's card for it goes, the
  // way a cancelled one does, and a requester's own request is read again, which makes the server
  // close it and send the usual update (with its popup). Runs again after every change to either
  // set of requests.
  useEffect(() => {
    const scheduledAtMs = Date.now();
    const pendingCloseTimes = (requests) =>
      requests.filter((req) => req.status === 'pending').map((req) => getClosesAtMs(req.createdAt));
    // A donor's card already past its time goes at once. A requester's request already past it
    // is not read again here: the server keeps it open until its own clock says so.
    const nextCloseAtMs = Math.min(
      ...pendingCloseTimes(incomingRequests),
      ...pendingCloseTimes(myRequests).filter((closesAtMs) => closesAtMs > scheduledAtMs)
    );
    if (!Number.isFinite(nextCloseAtMs)) return undefined;

    const timer = setTimeout(() => {
      const firedAtMs = Date.now();
      // Always a new array, so this effect runs again and waits for the next one
      setIncomingRequests((prev) => prev.filter((req) => !hasRunOut(req, firedAtMs)));
      const ownRequestRanOut = myRequestsRef.current.some((req) => {
        if (req.status !== 'pending') return false;
        const closesAtMs = getClosesAtMs(req.createdAt);
        return closesAtMs > scheduledAtMs && closesAtMs <= firedAtMs;
      });
      if (ownRequestRanOut) fetchDashboardData({ silent: true });
    }, Math.min(Math.max(nextCloseAtMs - scheduledAtMs, 0), MAX_TIMER_DELAY_MS));
    return () => clearTimeout(timer);
  }, [incomingRequests, myRequests]);

  // A device that slept can run the timer above long after the moment it was set for, so a donor's
  // requests whose hours ran out also go as soon as the page is shown again. The same array when
  // none has, so the timer above is not set up again for nothing.
  useEffect(() => {
    const dropRunOutIncoming = () => {
      if (document.visibilityState !== 'visible') return;
      const nowMs = Date.now();
      setIncomingRequests((prev) =>
        prev.some((req) => hasRunOut(req, nowMs)) ? prev.filter((req) => !hasRunOut(req, nowMs)) : prev
      );
    };
    document.addEventListener('visibilitychange', dropRunOutIncoming);
    return () => document.removeEventListener('visibilitychange', dropRunOutIncoming);
  }, []);

  const handleUpdateStatus = async (requestId, newStatus) => {
    try {
      await axiosInstance.patch(`/requests/${requestId}/status`, { status: newStatus });
      toast.success(`Request ${newStatus}`);
      reloadDashboardData(); // Refresh to get updated state
    } catch (err) {
      console.error(err);
      toast.error(err.response?.data?.message || 'Failed to update request status');
      // 403/404/409 mean the card no longer matches the server, so refresh to drop it
      if (err.response && [403, 404, 409].includes(err.response.status)) {
        reloadDashboardData();
      }
    }
  };

  const handleFulfill = async (requestId) => {
    try {
      await axiosInstance.patch(`/requests/${requestId}/fulfill`);
      toast.success('Request marked as fulfilled! 🎉');
      reloadDashboardData();
    } catch (err) {
      console.error(err);
      toast.error(err.response?.data?.message || 'Failed to mark as fulfilled');
    }
  };

  const handleRate = async (requestId) => {
    if (ratingValue === 0) {
      toast.error('Please select a rating');
      return;
    }
    try {
      setRatingLoading(true);
      await axiosInstance.post(`/requests/${requestId}/rate`, {
        rating: ratingValue,
        ratingNote: ratingNote,
      });
      toast.success('Rating submitted! Thank you. ⭐');
      setRatingRequestId(null);
      setRatingValue(0);
      setRatingNote('');
      reloadDashboardData();
    } catch (err) {
      console.error(err);
      toast.error(err.response?.data?.message || 'Failed to submit rating');
      // 409: the donor deleted their account since this card loaded, so refresh it
      if (err.response?.status === 409) {
        setRatingRequestId(null);
        setRatingValue(0);
        setRatingNote('');
        reloadDashboardData();
      }
    } finally {
      setRatingLoading(false);
    }
  };

  const UrgencyBadge = ({ urgency }) => {
    // The colour is in the fill and edge only, and the word in the card's text colour, as on a shared
    // request's page (PublicRequestPage.jsx): coloured words on their own tint measured 2.7:1 (low)
    // and 3.8:1 (high) in the light theme, and 1.3:1 (medium) in the dark one
    const colors = {
      low: 'bg-success/10 border-success/20',
      medium: 'bg-warning/10 border-warning/20',
      high: 'bg-error/10 border-error/20 font-bold'
    };
    return <div className={`badge border px-3 py-1 text-xs uppercase tracking-wider text-base-content ${colors[urgency] || 'badge-ghost'}`}>{urgency}</div>;
  };

  if (loading) {
    return (
      <div className="flex justify-center p-12 mt-12">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  return (
    // max-lg:pb-20: below lg, room under the last card, so at the foot of the page the round "+"
    // button sits below its buttons instead of on them
    <div className="space-y-8 pt-20 max-lg:pb-20">
      {/* Header Profile Section */}
      <m.div 
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="bg-base-100 rounded-3xl p-8 shadow-sm border border-base-300 flex flex-col sm:flex-row justify-between items-center gap-6 overflow-hidden relative"
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3"></div>
        <div className="z-10 relative min-w-0 flex-1 w-full text-center sm:text-left">
          <h1 className="text-3xl font-display font-extrabold text-base-content tracking-tight mb-1 truncate" title={`Welcome, ${authUser?.name || 'User'}`}>
            Welcome, {authUser?.name || 'User'}
          </h1>
          <p className="text-base-content/70 font-medium text-lg">Your Blood Group: <strong className="text-base-content bg-primary/10 px-3 py-1 rounded-full ml-1">{authUser?.bloodGroup || 'Not set'}</strong></p>
        </div>
        
        <div className="hidden lg:flex items-center gap-4 z-10 relative w-full sm:w-auto">
          <Link to="/create-request" className="btn btn-primary rounded-xl text-primary-content font-bold shadow-lg shadow-primary/20 border-none w-full sm:w-auto active:scale-95 transition-transform">
            <PlusIcon weight="bold" className="w-5 h-5 mr-1" />
            Request Blood
          </Link>
        </div>
      </m.div>

      {/* Your Impact Stats Card */}
      {stats && (stats.donor.livesSaved > 0 || stats.requester.totalCreated > 0) && (
        <m.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <StatsCard donorStats={stats.donor} requesterStats={stats.requester} />
        </m.div>
      )}

      {/* Mobile FAB. Not while a request is selected: below lg its chat then takes the place of the
          lists, and at the foot of the chat the button sat right on top of Send. "Back to Requests"
          brings it back. */}
      {!selectedRequestId && (
        <div className="lg:hidden fixed bottom-6 right-6 z-40">
          <Link to="/create-request" className="btn btn-primary btn-circle w-14 h-14 shadow-lg shadow-primary/30 glow-primary text-primary-content flex items-center justify-center active:scale-90 transition-transform">
            <PlusIcon weight="bold" className="w-7 h-7" />
          </Link>
        </div>
      )}

      {/* Push Notification Banner */}
      {'Notification' in window && !pushEnabled && (
        <m.div 
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-info/10 border border-info/20 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3">
            <div className="bg-info/20 p-2 rounded-full">
              <BellRingingIcon className="w-6 h-6 text-info" weight="duotone" />
            </div>
            <div>
              <h3 className="font-bold text-base-content text-sm sm:text-base">Enable Push Notifications</h3>
              <p className="text-xs sm:text-sm text-base-content/70">Get instantly alerted on your phone when an emergency matches your blood group.</p>
            </div>
          </div>
          <button onClick={enablePushNotifications} className="btn btn-info btn-sm rounded-lg text-base-100 font-semibold">Enable Now</button>
        </m.div>
      )}

      {/* The switch between the two request views, its red fill sliding to the chosen one.
          Narrower than 390 px the two buttons get less padding, and narrower than 360 px no icons,
          so both still fit side by side (with a two-digit count too) */}
      <div className={`flex justify-center sm:justify-start ${selectedRequestId ? 'hidden lg:flex' : 'flex'}`}>
        <div className="bg-base-100 border border-base-300 p-1.5 rounded-2xl inline-flex shadow-sm w-full sm:w-auto relative">
          <button 
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 min-[390px]:px-6 py-2.5 rounded-xl font-bold transition-all relative z-10 ${activeTab === 'incoming' ? 'text-primary-content' : 'text-base-content/60 hover:text-base-content'}`}
            onClick={() => { setActiveTab('incoming'); setSelectedRequestId(null); }}
          >
            {activeTab === 'incoming' && (
              <m.div layoutId="active-tab-indicator" className="absolute inset-0 bg-primary rounded-xl shadow-md -z-10" transition={{ type: 'spring', stiffness: 300, damping: 30 }} />
            )}
            {incomingRequests.filter(r => r.status === 'pending').length > 0 && (
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold mr-1 ${activeTab === 'incoming' ? 'bg-base-100 text-base-content' : 'bg-error text-base-100'}`}>
                {incomingRequests.filter(r => r.status === 'pending').length}
              </span>
            )}
            <BellRingingIcon weight={activeTab === 'incoming' ? "fill" : "regular"} className="w-5 h-5 max-[360px]:hidden" />
            <span className="relative z-10">Incoming Matches</span>
          </button>
          <button 
            className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 min-[390px]:px-6 py-2.5 rounded-xl font-bold transition-all relative z-10 ${activeTab === 'mine' ? 'text-primary-content' : 'text-base-content/60 hover:text-base-content'}`}
            onClick={() => { setActiveTab('mine'); setSelectedRequestId(null); }}
          >
            {activeTab === 'mine' && (
              <m.div layoutId="active-tab-indicator" className="absolute inset-0 bg-primary rounded-xl shadow-md -z-10" transition={{ type: 'spring', stiffness: 300, damping: 30 }} />
            )}
            <ClockClockwiseIcon weight={activeTab === 'mine' ? "fill" : "regular"} className="w-5 h-5 max-[360px]:hidden" />
            <span className="relative z-10">My Requests</span>
          </button>
        </div>
      </div>

      {/* Tab Content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 relative">
        {/* List Section */}
        <div className={`space-y-4 ${selectedRequestId ? 'hidden lg:block' : 'block'}`}>
          <AnimatePresence mode="wait">
            {activeTab === 'incoming' && (
              <m.div
                key="incoming"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.25 }}
                className="space-y-4"
              >
                <h2 ref={incomingHeadingRef} tabIndex={-1} className="text-xl font-bold mb-4 focus:outline-none">Requests Needing Your Help</h2>
                {isResting && (
                  <div id="donation-gap-notice" role="status" className="bg-success/10 border border-success/20 rounded-2xl p-4 text-sm font-medium text-base-content flex items-start gap-3">
                    <HandHeartIcon weight="duotone" className="w-6 h-6 text-success shrink-0" />
                    <p>
                      Thank you for donating! You can donate again from <span className="whitespace-nowrap">{formatIndiaDate(nextEligibleDonationAt)}</span>. We won't send you requests until then.
                    </p>
                  </div>
                )}
                {hasActiveDonation && (
                  <div role="status" className="bg-warning/10 border border-warning/20 rounded-2xl p-4 text-sm font-medium text-base-content">
                    You have an active donation. Complete it before accepting another.
                  </div>
                )}
                {incomingRequests.length === 0 ? (
                  <div className="text-center p-12 bg-base-100 rounded-2xl border border-base-300 text-base-content/60 shadow-sm">
                    <HandHeartIcon weight="duotone" className="w-16 h-16 mx-auto mb-4 text-primary/40" />
                    <h3 className="font-bold text-lg mb-1 text-base-content">You're all caught up!</h3>
                    <p>There are no emergency requests near you right now.</p>
                  </div>
                ) : (
                  <AnimatePresence>
                    {incomingRequests.map(req => (
                      <SwipeableRequestCard
                        key={req._id}
                        req={req}
                        onAccept={(id) => handleUpdateStatus(id, 'accepted')}
                        onDecline={(id) => handleUpdateStatus(id, 'declined')}
                        onSelect={setSelectedRequestId}
                        isSelected={selectedRequestId === req._id}
                        canAccept={canAcceptRequests}
                      >
                        {/* Fulfilled Thank You state for donor */}
                        {req.status === 'fulfilled' ? (
                          <div className="card-body p-5">
                            <div className="bg-success/5 border border-success/10 rounded-2xl p-5 text-center space-y-3">
                              <CheckCircleIcon weight="fill" className="w-12 h-12 text-success mx-auto" />
                              <h3 className="font-display font-bold text-lg text-base-content">Donation Complete!</h3>
                              <p className="text-sm text-base-content/70 wrap-anywhere">
                                Thank you for donating at <strong>{req.hospitalName}</strong>.
                              </p>
                              {req.rating ? (
                                <div className="space-y-1">
                                  <StarRating rating={req.rating} size="w-5 h-5" className="justify-center" />
                                  <p className="text-xs text-base-content/70">
                                    Rated {req.rating}/5 by the requester
                                  </p>
                                  {req.ratingNote && (
                                    <p className="text-sm italic text-base-content/70 mt-2">"{req.ratingNote}"</p>
                                  )}
                                </div>
                              ) : req.requesterId === null ? (
                                // Populated as null once the requester has deleted their account
                                <p className="text-xs text-base-content/70">Not rated. The requester deleted their account.</p>
                              ) : (
                                <p className="text-xs text-base-content/70">Awaiting rating from requester</p>
                              )}
                            </div>
                          </div>
                        ) : (
                          <>
                            {req.hospitalLocation?.coordinates && (
                              <div className="w-full relative bg-base-200 border-b border-base-200 overflow-hidden">
                                <MapErrorBoundary height="h-37.5">
                                  <Suspense fallback={<div className="h-37.5 flex items-center justify-center"><span className="loading loading-spinner text-primary"></span></div>}>
                                    <DonorMap
                                      hospitalLocation={req.hospitalLocation.coordinates}
                                      interactive={false}
                                      userLocation={authUser?.location?.coordinates}
                                      height="h-37.5"
                                    />
                                  </Suspense>
                                </MapErrorBoundary>
                              </div>
                            )}
                            <div className="card-body p-5">
                              {/* The match and urgency pills go below the name only when its longest word would
                                  not fit beside them. A word wider than the card (a name with no spaces) takes a
                                  whole row and breaks there: max-w-full caps the name's minimum width at the row,
                                  and block (card-title is flex) lets break-word break inside the h3 itself. */}
                              <div className="flex flex-wrap justify-between items-start gap-3">
                                <h3 className="card-title block flex-1 max-w-full wrap-break-word text-lg leading-snug">{req.hospitalName}</h3>
                                <div className="flex items-center gap-2 shrink-0">
                                  {req.matchType === 'exact' ? (
                                    <span className={`badge badge-sm h-auto py-1 px-2 whitespace-nowrap font-bold ${TINTED.success}`}>Exact Match</span>
                                  ) : req.matchType === 'compatible' ? (
                                    <span className={`badge badge-sm h-auto py-1 px-2 whitespace-nowrap font-bold ${TINTED.info}`}>Compatible Match</span>
                                  ) : null}
                                  <UrgencyBadge urgency={req.urgency} />
                                  {req.status === 'pending' && (
                                    <ReportBlockButton onOpen={() => setReportBlockTarget({ requestId: req._id, role: 'viewer' })} />
                                  )}
                                </div>
                              </div>
                              <p className="text-sm text-base-content/70">
                                Needs: <strong>{req.unitsNeeded} {req.unitsNeeded === 1 ? 'unit' : 'units'}</strong> of {req.bloodGroup}
                              </p>
                              
                              <div className="card-actions justify-end mt-4">
                                {req.status === 'pending' ? (
                                  <>
                                    {isResting ? (
                                      // A row of its own, so both buttons stay together below it
                                      <span className="w-full text-xs text-base-content/70 font-medium">
                                        You can donate from <span className="whitespace-nowrap">{formatIndiaDate(nextEligibleDonationAt)}</span>
                                      </span>
                                    ) : (
                                      <span className="text-xs text-base-content/70 font-medium self-center mr-2 md:hidden">
                                        Swipe or tap →
                                      </span>
                                    )}
                                    <button onClick={(e) => { e.stopPropagation(); handleUpdateStatus(req._id, 'declined'); }} className="btn btn-sm btn-ghost text-base-content/80">Decline</button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleUpdateStatus(req._id, 'accepted'); }}
                                      disabled={!canAcceptRequests}
                                      aria-describedby={isResting ? 'donation-gap-notice' : undefined}
                                      className={`btn btn-sm ${canAcceptRequests ? TINTED_BUTTON.success : ''}`}
                                    >
                                      Accept & Help
                                    </button>
                                  </>
                                ) : req.status === 'accepted' ? (
                                  <div className={`badge p-3 font-semibold ${TINTED.success}`}>Accepted by you</div>
                                ) : (
                                  <div className="badge">{req.status}</div>
                                )}
                              </div>
                            </div>
                          </>
                        )}
                      </SwipeableRequestCard>
                    ))}
                  </AnimatePresence>
                )}
              </m.div>
            )}

            {activeTab === 'mine' && (
              <m.div
                key="mine"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.25 }}
                className="space-y-4"
              >
                <h2 ref={mineHeadingRef} tabIndex={-1} className="text-xl font-bold mb-4 focus:outline-none">My Emergency Requests</h2>
                {myRequests.length === 0 ? (
                  <div className="text-center p-8 bg-base-100 rounded-xl border border-base-300 text-base-content/60">
                    You haven't made any blood requests.
                  </div>
                ) : (
                  <AnimatePresence>
                    {myRequests.map(req => (
                      <m.div 
                        key={req._id}
                        layout
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.3, layout: { duration: 0.25 } }}
                        onClick={() => req.status === 'accepted' && setSelectedRequestId(req._id)}
                        className={`card bg-base-100 shadow-md border transition-all ${req.status === 'accepted' ? 'cursor-pointer hover:border-primary' : 'border-base-200'} ${selectedRequestId === req._id ? 'border-primary ring-2 ring-primary/50' : ''}`}
                      >
                        <div className="card-body p-5">
                          {/* As on the incoming cards: the state pill goes below the name only when the
                              name's longest word would not fit beside it */}
                          <div className="flex flex-wrap justify-between items-start gap-y-2">
                            <h3 className="card-title block flex-1 max-w-full wrap-break-word text-lg">{req.hospitalName}</h3>
                            <div className={`badge shrink-0 ${
                              req.status === 'pending' ? TINTED.warning :
                              req.status === 'accepted' ? TINTED.success :
                              req.status === 'fulfilled' ? TINTED.info : ''
                            }`}>
                              {isExpiredRequest(req) ? 'EXPIRED' : isReportedRequest(req) ? 'CLOSED' : req.status.toUpperCase()}
                            </div>
                          </div>
                          <p className="text-sm text-base-content/70 mt-2">
                            {req.unitsNeeded} {req.unitsNeeded === 1 ? 'unit' : 'units'} • {req.bloodGroup}
                          </p>
                          {req.status === 'pending' && <OpenTimeLeft createdAt={req.createdAt} />}

                          {/* Closed after its open hours with no donor. Posting again opens the form filled in
                              with this request's details; the requester sends it from there. */}
                          {isExpiredRequest(req) && (
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                              <p className="text-sm text-base-content/70">{EXPIRED_NOTE}</p>
                              <Link
                                to="/create-request"
                                state={buildRepostState(req)}
                                className="btn btn-sm btn-outline btn-primary rounded-xl font-bold"
                              >
                                Post again
                              </Link>
                            </div>
                          )}

                          {/* Closed by the server after reports. No "Post again", and nothing about who reported it. */}
                          {isReportedRequest(req) && (
                            <p className="mt-3 text-sm text-base-content/70">{REPORTED_NOTE}</p>
                          )}

                          {/* Still without a donor, so the requester can ask people outside the app too */}
                          {req.status === 'pending' && (
                            <div className={`mt-4 ${CLEAR_OF_ROUND_BUTTON}`}>
                              <ShareRequestButtons request={req} />
                            </div>
                          )}

                          {/* Accepted state: show chat prompt + fulfill button */}
                          {req.status === 'accepted' && (
                            <div className={`space-y-3 mt-2 ${CLEAR_OF_ROUND_BUTTON}`}>
                              <div className="alert alert-success bg-success/10 text-base-content border-success/20 p-2 flex justify-center text-center">
                                A donor has accepted this request! Open chat to coordinate.
                              </div>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleFulfill(req._id); }}
                                className="btn btn-sm btn-primary w-full rounded-xl font-bold shadow-sm"
                              >
                                <CheckCircleIcon weight="bold" className="w-4 h-4" />
                                Mark as Fulfilled
                              </button>
                            </div>
                          )}

                          {/* Fulfilled state: show rating widget or rating result */}
                          {req.status === 'fulfilled' && (
                            <div className="mt-3 space-y-3">
                              <div className="flex items-center gap-2 text-sm text-info font-semibold">
                                <CheckCircleIcon weight="fill" className="w-4 h-4" />
                                {/* The day in India, wherever the browser is */}
                                <span>
                                  Fulfilled{req.fulfilledAt && <> on <span className="whitespace-nowrap">{formatIndiaDate(req.fulfilledAt)}</span></>}
                                </span>
                              </div>

                              {req.rating ? (
                                /* Already rated — show static result */
                                <div className="bg-warning/5 border border-warning/10 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-3">
                                  <div className="flex items-center gap-2">
                                    <StarRating rating={req.rating} size="w-4 h-4" />
                                    <span className="text-sm font-semibold text-base-content/70">{req.rating}/5</span>
                                  </div>
                                  {req.ratingNote && (
                                    <span className="text-xs italic text-base-content/70 sm:ml-auto truncate max-w-full sm:max-w-37.5" title={req.ratingNote}>"{req.ratingNote}"</span>
                                  )}
                                </div>
                              ) : !req.matchedDonorId ? (
                                /* The donor deleted their account; the server refuses a rating too */
                                <p className="text-xs text-base-content/70">
                                  Donated by Deleted user. This donation can't be rated.
                                </p>
                              ) : ratingRequestId === req._id ? (
                                /* Rating form is open */
                                <m.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: 'auto' }}
                                  className="bg-base-200/50 border border-base-300 rounded-xl p-4 space-y-3 text-center"
                                >
                                  <p className="text-sm font-semibold text-base-content">Rate your experience</p>
                                  <StarRating rating={ratingValue} onRate={setRatingValue} interactive size="w-8 h-8" className="justify-center" />
                                  <input
                                    type="text"
                                    placeholder="Optional: leave a note for the donor..."
                                    className="input input-sm w-full rounded-lg border-base-300 focus:border-primary focus:ring-1 focus:ring-primary text-base"
                                    value={ratingNote}
                                    onChange={(e) => setRatingNote(e.target.value)}
                                    maxLength={500}
                                  />
                                  <div className="flex gap-2">
                                    <button
                                      onClick={() => { setRatingRequestId(null); setRatingValue(0); setRatingNote(''); }}
                                      className="btn btn-sm btn-ghost flex-1"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      onClick={() => handleRate(req._id)}
                                      disabled={ratingValue === 0 || ratingLoading}
                                      className={`btn btn-sm flex-1 font-bold ${ratingValue === 0 || ratingLoading ? '' : TINTED_BUTTON.warning}`}
                                    >
                                      {ratingLoading ? <span className="loading loading-spinner loading-xs"></span> : 'Submit Rating'}
                                    </button>
                                  </div>
                                </m.div>
                              ) : (
                                /* Not yet rated — show rate button. The open form above keeps the full
                                   width: at 320 px, 52 px less would wrap "Submit Rating". */
                                <div className={CLEAR_OF_ROUND_BUTTON}>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setRatingRequestId(req._id); }}
                                    className={`btn btn-sm w-full rounded-xl font-bold ${TINTED_BUTTON.warning}`}
                                  >
                                    <StarIcon weight="bold" className="w-4 h-4" />
                                    Rate this Donor
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </m.div>
                    ))}
                  </AnimatePresence>
                )}
              </m.div>
            )}
          </AnimatePresence>
        </div>

        {/* Chat Section */}
        <div className={`w-full lg:sticky lg:top-24 h-fit mt-8 lg:mt-0 ${!selectedRequestId ? 'hidden lg:block' : 'block'}`}>
          {(() => {
            // Find the specifically selected request
            let activeChatRequest = null;
            
            if (selectedRequestId) {
              const currentList = activeTab === 'incoming' ? incomingRequests : myRequests;
              activeChatRequest = currentList.find(r => r._id === selectedRequestId);
            }

            // Below lg the request list is hidden while a request is selected, so this is the only way back
            const backToRequestsButton = (
              <button
                onClick={() => setSelectedRequestId(null)}
                className="lg:hidden shrink-0 whitespace-nowrap text-primary-strong font-bold text-sm bg-primary/10 px-3 py-1 rounded-full active:scale-95 transition-transform"
              >
                ← Back to Requests
              </button>
            );

            if (activeChatRequest && activeChatRequest.status === 'accepted') {
              return (
                <m.div 
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3 }}
                  className="w-full flex flex-col"
                >
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="text-sm font-semibold opacity-70 min-w-0 wrap-anywhere">
                      Coordinating for: {activeChatRequest.hospitalName}
                    </div>
                    {backToRequestsButton}
                  </div>
                  <ChatWindow
                    requestId={activeChatRequest._id}
                    currentUserId={authUser._id}
                    headerAction={
                      <ReportBlockButton
                        onOpen={() => setReportBlockTarget({
                          requestId: activeChatRequest._id,
                          // The incoming list holds the requests this user donates to
                          role: activeTab === 'incoming' ? 'donor' : 'requester',
                        })}
                      />
                    }
                  />
                </m.div>
              );
            }
            return (
              <>
                {selectedRequestId && (
                  <div className="flex justify-end mb-2 lg:hidden">
                    {backToRequestsButton}
                  </div>
                )}
                <div className="h-125 bg-base-100 rounded-xl border border-base-300 flex items-center justify-center text-base-content/70 text-center p-8">
                  <div>
                    <div className="text-4xl mb-4">💬</div>
                    <h3 className="font-bold text-lg mb-2">Coordination Chat</h3>
                    <p>When a request is accepted, real-time chat will appear here.</p>
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      {reportBlockTarget && (
        <ReportBlockDialog
          requestId={reportBlockTarget.requestId}
          role={reportBlockTarget.role}
          onClose={() => {
            setReportBlockTarget(null);
            // The dialog gives focus back to its button, unless that button has already gone
            setTimeout(focusListHeadingIfLost, 0);
          }}
          onChanged={() =>
            fetchDashboardData({ silent: true }).then(() => setTimeout(focusListHeadingIfLost, CARD_EXIT_MS))
          }
        />
      )}
    </div>
  );
};

// main.jsx gives every page motion's animations. This one also drags its request cards and slides
// the marker under the selected list (layout), and the code for those two comes with this page.
const DashboardPageWithDragAndLayout = () => (
  <LazyMotion features={domMax} strict>
    <DashboardPage />
  </LazyMotion>
);

export default DashboardPageWithDragAndLayout;
