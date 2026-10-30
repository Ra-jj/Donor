/**
 * How long a request stays open to donors.
 *
 * A pending request closes REQUEST_OPEN_HOURS after it was created (createdAt, also for a request
 * that went back to pending when its donor deleted their account). Closing it is an automatic
 * cancel: status 'cancelled' with closedReason 'expired', so every rule for cancelled requests
 * (incoming, chat, account deletion, stats, history, matching) applies to it unchanged. Accepted,
 * fulfilled and cancelled requests never expire.
 *
 * The server sleeps when idle (Render's free plan), so no timer can be trusted to close a request
 * on time. Expiry is therefore enforced from createdAt wherever it matters:
 *   - reads: getIncomingRequests never lists a pending request past its hours;
 *   - writes: an accept, a decline, or a cancel of a pending request matches only a request still
 *     inside them;
 *   - expireStaleRequests below marks the ones past them and tells each requester. It runs at
 *     startup, every SWEEP_INTERVAL_MS while the server is awake, and on reads: a requester's own
 *     reads wait for their requests to be closed, and getIncomingRequests starts a throttled
 *     sweep over all requests without waiting for it.
 */
const Request = require('../models/request.model');
const { io } = require('../lib/socket');

// The client shows the same number (client/src/lib/requestExpiry.js); a test checks the two match
const REQUEST_OPEN_HOURS = 48;
const REQUEST_OPEN_MS = REQUEST_OPEN_HOURS * 60 * 60 * 1000;

// While awake, the server closes requests at least this often
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// The sweep that getIncomingRequests starts runs at most once per this gap. That read never lists
// an expired request either way, so the sweep there only tells requesters sooner.
const LAZY_SWEEP_MIN_GAP_MS = 60 * 1000;
// Closing writes a sweep has in flight at once. A backlog (the first sweep after the server slept,
// or after this feature first shipped) then closes several times faster than one write at a time,
// while the rest of the connection pool stays free for the requests being served meanwhile.
const SWEEP_WRITE_BATCH_SIZE = 10;

/**
 * The newest createdAt a request can have and be past its open hours at nowMs.
 * @param {number} [nowMs]
 * @returns {Date}
 */
const getRequestOpenCutoff = (nowMs = Date.now()) => new Date(nowMs - REQUEST_OPEN_MS);

// Request filter: created inside the open hours, so a pending one is still open. A field-level
// condition, so callers can spread it into a query that has its own $or.
const stillOpenFilter = (nowMs = Date.now()) => ({ createdAt: { $gt: getRequestOpenCutoff(nowMs) } });

// Request filter: pending and past its open hours, what the sweep closes
const staleFilter = (nowMs) => ({ status: 'pending', createdAt: { $lte: getRequestOpenCutoff(nowMs) } });

/**
 * Whether a request is closed by expiry, or is pending and past its open hours (not yet swept).
 * @param {{ status: string, createdAt: Date, closedReason?: string }} request
 * @param {number} [nowMs]
 * @returns {boolean}
 */
const hasExpired = (request, nowMs = Date.now()) =>
  request.closedReason === 'expired' ||
  (request.status === 'pending' && request.createdAt.getTime() <= getRequestOpenCutoff(nowMs).getTime());

/**
 * Closes one candidate the sweep read, and tells its requester if this write is the one that
 * closed it.
 * @returns {Promise<boolean>} whether this write closed it
 */
const closeStaleCandidate = async (candidate, nowMs) => {
  const { matchedCount } = await Request.updateOne(
    { _id: candidate._id, ...staleFilter(nowMs) },
    { $set: { status: 'cancelled', closedReason: 'expired' } }
  );
  if (matchedCount !== 1) return false;

  // The write has happened, so a failed emit is logged and the rest are still closed. The
  // requester's own room only: no donor holds an expired request, and donors' screens drop the
  // card by themselves at the same moment (pages/DashboardPage.jsx).
  try {
    io.to(String(candidate.requesterId)).emit('requestStatusUpdate', {
      requestId: candidate._id,
      status: 'cancelled',
      reason: 'expired',
      hospitalName: candidate.hospitalName,
    });
  } catch (error) {
    console.error(`Closing expired requests: failed to notify requester of request ${candidate._id}:`, error.message);
  }
  return true;
};

/**
 * Closes every pending request past its open hours, and tells each requester once.
 *
 * Candidates are read first, then each is closed with its own conditional write, up to
 * SWEEP_WRITE_BATCH_SIZE of them at a time. The status and createdAt conditions are part of that
 * write, so an accept, a cancel or another sweep that got there first makes it match nothing, and
 * only the one write that matched sends the event. An updateMany would close them all in one call,
 * but it reports only a count, not which documents this run changed, so it could not notify
 * exactly those.
 *
 * A failed write stops the run (it rejects with that error), once the other writes of its batch
 * have settled: none of this run's writes is still going when it settles.
 *
 * @param {object} [options]
 * @param {number} [options.nowMs]
 * @param {object} [options.scope] - extra conditions, e.g. { requesterId } to close only one user's
 * @returns {Promise<import('mongoose').Types.ObjectId[]>} the ids this run closed
 */
const expireStaleRequests = async ({ nowMs = Date.now(), scope = {} } = {}) => {
  const candidates = await Request.find({ ...scope, ...staleFilter(nowMs) })
    .select('_id requesterId hospitalName')
    .lean();

  const expiredIds = [];
  for (let start = 0; start < candidates.length; start += SWEEP_WRITE_BATCH_SIZE) {
    const batch = candidates.slice(start, start + SWEEP_WRITE_BATCH_SIZE);
    const outcomes = await Promise.allSettled(batch.map((candidate) => closeStaleCandidate(candidate, nowMs)));
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    batch.forEach((candidate, index) => {
      if (outcomes[index].value) expiredIds.push(candidate._id);
    });
  }
  return expiredIds;
};

// For callers that must not fail because of the sweep: logs a failure and resolves to []
const expireStaleRequestsLogged = (options) =>
  expireStaleRequests(options).catch((error) => {
    console.error('Closing expired requests failed:', error.message);
    return [];
  });

/**
 * Closes one requester's expired requests, before a read of their own requests. Unthrottled, so
 * they always see the right state, even right after the server woke up. Cheap: one query on the
 * { status, createdAt } index, which reads only the pending requests already past their hours
 * (few, as the sweeps keep closing them) and returns none unless one is theirs. Never rejects.
 * @param {import('mongoose').Types.ObjectId} requesterId
 */
const expireRequesterStaleRequests = (requesterId) => expireStaleRequestsLogged({ scope: { requesterId } });

let globalSweepInFlight = null;
let lastGlobalSweepStartedAtMs = -Infinity;

// One sweep over all requests at a time: a caller that arrives while one runs waits for that one
const runGlobalSweep = (nowMs = Date.now()) => {
  if (!globalSweepInFlight) {
    lastGlobalSweepStartedAtMs = nowMs;
    globalSweepInFlight = expireStaleRequestsLogged({ nowMs }).finally(() => {
      globalSweepInFlight = null;
    });
  }
  return globalSweepInFlight;
};

/**
 * The sweep getIncomingRequests starts: at most once per LAZY_SWEEP_MIN_GAP_MS (the startup and
 * interval sweeps count too), joining one that is already running. Never rejects, so a caller
 * may leave it running without awaiting it.
 * @param {number} [nowMs]
 * @returns {Promise<import('mongoose').Types.ObjectId[]>} the ids it closed, [] when skipped
 */
const expireStaleRequestsIfDue = (nowMs = Date.now()) => {
  if (globalSweepInFlight) return globalSweepInFlight;
  if (nowMs - lastGlobalSweepStartedAtMs < LAZY_SWEEP_MIN_GAP_MS) return Promise.resolve([]);
  return runGlobalSweep(nowMs);
};

/**
 * Sweeps once now, then every SWEEP_INTERVAL_MS while the process runs. The interval is unref'd,
 * so it never keeps the process alive: shutdown (and Jest) can exit with it scheduled.
 * @returns {{ firstSweep: Promise<import('mongoose').Types.ObjectId[]>, stop: () => void }}
 */
const startRequestExpirySweeps = () => {
  const firstSweep = runGlobalSweep();
  // A wrapper, so the timer's own arguments never reach runGlobalSweep as nowMs
  const timer = setInterval(() => runGlobalSweep(), SWEEP_INTERVAL_MS);
  timer.unref();
  return { firstSweep, stop: () => clearInterval(timer) };
};

module.exports = {
  REQUEST_OPEN_HOURS,
  SWEEP_INTERVAL_MS,
  LAZY_SWEEP_MIN_GAP_MS,
  getRequestOpenCutoff,
  stillOpenFilter,
  hasExpired,
  expireStaleRequests,
  expireStaleRequestsLogged,
  expireRequesterStaleRequests,
  expireStaleRequestsIfDue,
  startRequestExpirySweeps,
};
