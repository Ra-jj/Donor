import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  CheckCircleIcon,
  ClockIcon,
  HospitalIcon,
  HourglassMediumIcon,
  LinkBreakIcon,
  WarningCircleIcon,
  XCircleIcon,
  ArrowClockwiseIcon,
} from '@phosphor-icons/react';
import { axiosInstance } from '../lib/axios';
import { useAuthStore } from '../store/useAuthStore';
import { URGENCY_LEVELS } from '../lib/urgencyLevels';
import { formatIndiaDate, formatIndiaTime } from '../lib/donationGap';

// The page a shared request's link opens (/r/<share token>, see lib/shareRequest.js), for anyone,
// signed in or not. The server answers GET /api/public/requests/:token with only what this page
// shows: the four fields of an open request and when it closes, or just its state once it has a
// donor or is closed. Nothing about the requester, and no id, ever reaches this page.

const URGENCY_LABELS = Object.fromEntries(URGENCY_LEVELS.map(({ value, label }) => [value, label]));

// The dashboard's urgency colours (UrgencyBadge in pages/DashboardPage.jsx) for the fill and edge.
// The label itself is in the page's text colour: the coloured text on its own tint is too faint to
// read at this size in the light theme.
const URGENCY_PILL_CLASSES = {
  low: 'bg-success/10 border-success/20',
  medium: 'bg-warning/10 border-warning/20',
  high: 'bg-error/10 border-error/20 font-bold',
};

const KNOWN_STATES = ['open', 'donor_found', 'closed'];

// What the server sent, if it is one of the answers this page knows. Anything else is treated as
// a failed load, so a changed server never shows half a request.
const readSharedRequest = (data) => {
  if (!data || !KNOWN_STATES.includes(data.state)) return null;
  if (data.state !== 'open') return { state: data.state };
  const { bloodGroup, unitsNeeded, hospitalName, urgency, expiresAt } = data;
  const isComplete =
    typeof bloodGroup === 'string' &&
    Number.isInteger(unitsNeeded) &&
    typeof hospitalName === 'string' &&
    Object.hasOwn(URGENCY_LABELS, urgency) &&
    Number.isFinite(Date.parse(expiresAt));
  return isComplete ? { state: 'open', bloodGroup, unitsNeeded, hospitalName, urgency, expiresAt } : null;
};

// How a failed load is told apart. Neither a badly formed link (400) nor a well-formed one that
// matches no request (404, e.g. its requester deleted their account) is worth retrying; anything
// else is.
const describeLoadFailure = (error) => {
  const httpStatus = error?.response?.status;
  if (httpStatus === 400) return { status: 'bad_link' };
  if (httpStatus === 404) return { status: 'not_found' };
  // The server's own words for a 429 say how long to wait
  const message = httpStatus === 429 && typeof error.response.data?.message === 'string'
    ? error.response.data.message
    : 'Check your connection and try again.';
  return { status: 'error', message };
};

const StateIcon = ({ icon: Icon, className }) => (
  <div className={`w-14 h-14 rounded-2xl flex items-center justify-center border ${className}`}>
    <Icon weight="duotone" className="w-7 h-7" aria-hidden="true" />
  </div>
);

/** Sign up or log in for a visitor, the dashboard for someone signed in, under every state */
const AccountActions = ({ isSignedIn, note }) => (
  <div className="border-t border-base-300 bg-base-200/50 p-6 sm:p-8 space-y-4">
    <p className="text-sm text-base-content/70 leading-relaxed">{note}</p>
    {isSignedIn ? (
      <Link to="/dashboard" className="btn btn-primary w-full min-h-11 h-auto py-2 rounded-xl text-primary-content font-bold border-none shadow-lg shadow-primary/20">
        Open dashboard
      </Link>
    ) : (
      <div className="flex flex-col sm:flex-row gap-3">
        <Link to="/register" className="btn btn-primary flex-1 min-h-11 h-auto py-2 rounded-xl text-primary-content font-bold border-none shadow-lg shadow-primary/20">
          Sign up to donate
        </Link>
        <Link to="/login" className="btn flex-1 min-h-11 h-auto py-2 rounded-xl font-semibold bg-base-100 border-base-300 hover:bg-base-200">
          Log in
        </Link>
      </div>
    )}
  </div>
);

const PublicRequestPage = () => {
  const { token } = useParams();
  const { authUser } = useAuthStore();
  // { status: 'loading' } | { status: 'loaded', request } | { status: 'bad_link' } (400)
  // | { status: 'not_found' } (404) | { status: 'error', message } (anything else: can be retried)
  const [result, setResult] = useState({ status: 'loading' });
  // Retry bumps this, which loads the request again
  const [loadAttempt, setLoadAttempt] = useState(0);
  const headingRef = useRef(null);

  useEffect(() => {
    let isCancelled = false;
    // encodeURIComponent: a mangled link must reach the server as one path segment, to be refused there
    axiosInstance.get(`/public/requests/${encodeURIComponent(token)}`)
      .then((res) => {
        if (isCancelled) return;
        const request = readSharedRequest(res.data);
        if (request) {
          setResult({ status: 'loaded', request });
        } else {
          console.error('Unexpected answer for a shared request:', res.data);
          setResult({ status: 'error', message: 'Please try again in a moment.' });
        }
      })
      .catch((error) => {
        if (isCancelled) return;
        if (!error.response || error.response.status >= 500) console.error('Loading a shared request failed:', error);
        setResult(describeLoadFailure(error));
      });
    return () => {
      isCancelled = true;
    };
  }, [token, loadAttempt]);

  // After a retry the button that had the focus is gone, so the focus goes to what replaced it
  useEffect(() => {
    if (loadAttempt > 0 && result.status !== 'loading') headingRef.current?.focus();
  }, [loadAttempt, result.status]);

  const retry = () => {
    setResult({ status: 'loading' });
    setLoadAttempt((attempt) => attempt + 1);
  };

  const isSignedIn = Boolean(authUser);
  const cardClassName = 'bg-base-100 rounded-3xl border border-base-300 shadow-sm overflow-hidden';
  const headingClassName = 'text-2xl font-display font-bold text-base-content tracking-tight wrap-break-word';
  const generalNote = 'Donor alerts compatible donors near a hospital when someone there needs blood.';

  if (result.status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-[50vh]" role="status">
        <span className="loading loading-spinner loading-lg text-primary" aria-hidden="true"></span>
        <span className="sr-only">Loading the request</span>
      </div>
    );
  }

  if (result.status === 'loaded' && result.request.state === 'open') {
    const { bloodGroup, unitsNeeded, hospitalName, urgency, expiresAt } = result.request;
    return (
      <article aria-labelledby="shared-request-heading" className={cardClassName}>
        {/* The red edge of an open request's card on the dashboard */}
        <div className="h-1 w-full bg-error" />
        <div className="p-6 sm:p-8 space-y-6">
          <div className="flex items-center gap-4">
            {/* The blood group is read out as part of the heading */}
            <div aria-hidden="true" className="w-20 h-20 shrink-0 rounded-2xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center">
              <span className="text-3xl font-display font-extrabold tracking-tight">{bloodGroup}</span>
            </div>
            <div className="min-w-0">
              <h1 id="shared-request-heading" ref={headingRef} tabIndex={-1} className={headingClassName}>
                <span className="sr-only">{bloodGroup} </span>Blood needed
              </h1>
              <p className="text-base-content/70 font-semibold mt-1">
                {unitsNeeded} {unitsNeeded === 1 ? 'unit' : 'units'}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <HospitalIcon weight="duotone" className="w-6 h-6 text-primary shrink-0 mt-0.5" aria-hidden="true" />
            {/* min-w-0 and break-word: a name with no spaces wraps inside the card instead of widening it */}
            <p className="min-w-0 flex-1 text-lg font-semibold text-base-content leading-snug wrap-break-word">
              <span className="sr-only">Hospital: </span>
              {hospitalName}
            </p>
          </div>

          <div className="space-y-3">
            <p>
              <span className={`badge border h-auto py-1 px-3 text-sm text-base-content ${URGENCY_PILL_CLASSES[urgency]}`}>
                <span className="sr-only">Urgency: </span>
                {URGENCY_LABELS[urgency]}
              </span>
            </p>
            <p className="flex items-start gap-2 text-sm text-base-content/70">
              <ClockIcon weight="regular" className="w-5 h-5 shrink-0" aria-hidden="true" />
              <span>
                Open until <span className="whitespace-nowrap">{formatIndiaDate(expiresAt)},</span>{' '}
                <span className="whitespace-nowrap">{formatIndiaTime(expiresAt)}</span>
              </span>
            </p>
          </div>
        </div>
        <AccountActions isSignedIn={isSignedIn} note="Donor alerts compatible donors within 15 km of the hospital." />
      </article>
    );
  }

  // Every other state: one line, with an icon, and the same account actions
  let stateContent;
  if (result.status === 'loaded' && result.request.state === 'donor_found') {
    stateContent = {
      icon: <StateIcon icon={CheckCircleIcon} className="bg-success/10 border-success/20 text-success" />,
      heading: 'A donor has been found for this request. Thank you.',
    };
  } else if (result.status === 'loaded') {
    stateContent = {
      icon: <StateIcon icon={HourglassMediumIcon} className="bg-base-200 border-base-300 text-base-content/60" />,
      heading: 'This request is no longer open.',
    };
  } else if (result.status === 'not_found') {
    stateContent = {
      icon: <StateIcon icon={XCircleIcon} className="bg-base-200 border-base-300 text-base-content/60" />,
      heading: 'This request is no longer available.',
    };
  } else if (result.status === 'bad_link') {
    stateContent = {
      icon: <StateIcon icon={LinkBreakIcon} className="bg-base-200 border-base-300 text-base-content/60" />,
      heading: "This link doesn't work.",
      detail: 'Check that the whole link was copied, or ask the person who shared it to send it again.',
    };
  } else {
    stateContent = {
      icon: <StateIcon icon={WarningCircleIcon} className="bg-warning/10 border-warning/20 text-warning" />,
      heading: "This request couldn't be loaded.",
      detail: result.message,
      canRetry: true,
    };
  }

  return (
    <article aria-labelledby="shared-request-heading" className={cardClassName}>
      <div className="p-6 sm:p-8 space-y-4">
        {stateContent.icon}
        <h1 id="shared-request-heading" ref={headingRef} tabIndex={-1} className={headingClassName}>
          {stateContent.heading}
        </h1>
        {stateContent.detail && <p className="text-base-content/70 leading-relaxed">{stateContent.detail}</p>}
        {stateContent.canRetry && (
          <button type="button" onClick={retry} className="btn btn-outline btn-primary rounded-xl font-bold min-h-11">
            <ArrowClockwiseIcon weight="bold" className="w-5 h-5" aria-hidden="true" />
            Try again
          </button>
        )}
      </div>
      <AccountActions isSignedIn={isSignedIn} note={generalNote} />
    </article>
  );
};

export default PublicRequestPage;
