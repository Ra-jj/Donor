/**
 * The home page's two totals, GET /api/public/stats, for anyone, with or without an account:
 *   - donationsCompleted: every fulfilled Request. Also those whose requester or donor has since
 *     deleted their account: the donation happened, and such requests are kept, anonymised
 *     (deleteAccount in user.controller.js). Outside donations are self-reported, so not counted.
 *   - peopleRegistered: the accounts that exist now. Every account can both ask for blood and
 *     donate (there is no donor or requester role), so these are people, not donors. A deleted
 *     account is erased, so it no longer counts.
 * Counts only, the same for everyone: nothing about any one user.
 */
const Request = require('../models/request.model');
const User = require('../models/user.model');

// The database is counted at most this often per process; every call in between gets the copy
const PUBLIC_STATS_CACHE_MS = 10 * 60 * 1000;

// public: the answer is the same for everyone and holds no personal data, so a browser (and any
// shared cache on the way) may keep it. With the server's own copy, a total is at most about
// 15 minutes old, which is fine for numbers that only grow slowly. A visitor who comes back to
// the home page within the 5 minutes makes no request at all.
const PUBLIC_STATS_CACHE_CONTROL = 'public, max-age=300';

let cachedStats = null;
let statsCountInFlight = null;

// Exact counts. The first uses the { status, fulfilledAt, matchedDonorId } index; the second reads
// every user, which the cache above keeps to once per PUBLIC_STATS_CACHE_MS. Not
// estimatedDocumentCount: that reads collection metadata, which can be off after an unclean shutdown.
const countPublicStats = async () => {
  const [donationsCompleted, peopleRegistered] = await Promise.all([
    Request.countDocuments({ status: 'fulfilled' }),
    User.countDocuments({}),
  ]);
  return { donationsCompleted, peopleRegistered };
};

/**
 * The totals, from the copy in memory while it is younger than PUBLIC_STATS_CACHE_MS. Calls that
 * arrive while a count is running share it. A failed count is not kept, so the next call counts
 * again.
 * @param {number} [nowMs]
 * @returns {Promise<{ donationsCompleted: number, peopleRegistered: number }>}
 */
const readPublicStats = (nowMs = Date.now()) => {
  if (cachedStats && nowMs < cachedStats.expiresAtMs) return Promise.resolve(cachedStats.value);
  if (!statsCountInFlight) {
    statsCountInFlight = countPublicStats()
      .then((value) => {
        cachedStats = { value, expiresAtMs: nowMs + PUBLIC_STATS_CACHE_MS };
        return value;
      })
      .finally(() => {
        statsCountInFlight = null;
      });
  }
  return statsCountInFlight;
};

// For tests: the next read counts again
const clearPublicStatsCache = () => {
  cachedStats = null;
};

const getPublicStats = async (req, res) => {
  try {
    const stats = await readPublicStats();
    // Replaces the router's no-store for this answer only; errors and 429s keep no-store
    res.set('Cache-Control', PUBLIC_STATS_CACHE_CONTROL);
    res.status(200).json(stats);
  } catch (error) {
    console.error('Error in getPublicStats:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

module.exports = {
  PUBLIC_STATS_CACHE_MS,
  PUBLIC_STATS_CACHE_CONTROL,
  readPublicStats,
  clearPublicStatsCache,
  getPublicStats,
};
