/**
 * "You can donate again": one web push to a donor when their gap between donations ends.
 *
 * Who: a donor with a push subscription, "Available to donate" on (isAvailable: switched off, they
 * have opted out of being asked to donate), and at least one donation (a fulfilled Request as its
 * donor, or the outside donation date they entered), whose gap (utils/donationGap.js) ended at
 * most REMINDER_WINDOW_DAYS ago. The moment it ends is 00:00 IST on the first day they may donate
 * (computeNextEligibleDonationAt), read from their latest donation, so a newer donation moves it
 * later. Nothing older than the window: when the server slept through a donor's day, or when this
 * first ships, donors who could donate long ago are not all told at once.
 *
 * Once per moment: User.donationReminderSentFor holds the moment the last reminder was for. Each
 * send is claimed first by one conditional write that matches only while that field is earlier
 * than the moment (or absent), and only the write that matched sends. Two sweeps at once, in one
 * process or in two, therefore send it once. A later donation, through Donor or a later outside
 * date, gives a later moment and so one new reminder.
 *
 * When: between REMINDER_FIRST_HOUR_IST and REMINDER_END_HOUR_IST in India, since the moment itself
 * is midnight. Like the expiry sweep (utils/requestExpiry.js), it runs at startup, every
 * SWEEP_INTERVAL_MS while the server is awake, and on reads: checkAuth (every page load of a
 * signed-in user) and getIncomingRequests start a throttled sweep without waiting for it
 * (sendDonationRemindersIfDue). Render's free plan sleeps after about 15 idle minutes, so the
 * interval seldom fires and the startup sweep may land at night; any visit in the daytime then
 * sends what is due.
 *
 * Without VAPID keys (utils/webPush.js) nothing is sent and nothing is claimed, so a reminder
 * still inside its window goes out once the keys are set. A claimed reminder whose send fails is
 * not tried again: once at most, never twice.
 */
const Request = require('../models/request.model');
const User = require('../models/user.model');
const { describePushEndpointProblem } = require('../validators/pushValidator');
const {
  DONATION_GAP_DAYS,
  computeNextEligibleDonationAt,
  findLatestDonationAt,
  toIndiaDayNumber,
  indiaDayStartMs,
} = require('./donationGap');
const { webpush, isWebPushConfigured } = require('./webPush');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A gap that ended longer ago than this gets no reminder
const REMINDER_WINDOW_DAYS = 3;
const REMINDER_WINDOW_MS = REMINDER_WINDOW_DAYS * DAY_MS;

// Reminders go out from 08:00 until 21:00 India time, never at night
const REMINDER_FIRST_HOUR_IST = 8;
const REMINDER_END_HOUR_IST = 21;

// While awake, the server looks for donors to remind at least this often
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
// The sweep that reads start runs at most once per this gap (the startup and interval sweeps count
// too), so a burst of page loads costs at most one sweep
const LAZY_SWEEP_MIN_GAP_MS = 10 * 60 * 1000;

// Donors one sweep handles at once, as in requestExpiry.js: a backlog after the server woke up
// goes faster than one at a time, and the rest of the connection pool stays free meanwhile
const SWEEP_BATCH_SIZE = 10;

// What the donor's service worker shows (client/src/sw.js): title, body and icon, and data.url,
// the page a tap on it opens
const DONATION_REMINDER_NOTIFICATION = Object.freeze({
  title: 'You can donate again',
  body: 'You can donate blood again from today. Thank you for helping.',
  icon: '/pwa-192x192.png',
  data: Object.freeze({ url: '/dashboard' }),
});

/**
 * The push payload of a donation reminder, the same for every donor: it names no one.
 * @returns {string}
 */
const buildDonationReminderPayload = () => JSON.stringify(DONATION_REMINDER_NOTIFICATION);

/**
 * Whether nowMs is inside the hours reminders go out, in India
 * @param {number} nowMs
 * @returns {boolean}
 */
const isReminderHourInIndia = (nowMs) => {
  const msSinceIndiaMidnight = nowMs - indiaDayStartMs(toIndiaDayNumber(nowMs));
  return msSinceIndiaMidnight >= REMINDER_FIRST_HOUR_IST * HOUR_MS && msSinceIndiaMidnight < REMINDER_END_HOUR_IST * HOUR_MS;
};

/**
 * Donation instants whose gap ends between windowStartMs and nowMs. A gap ends at 00:00 IST,
 * DONATION_GAP_DAYS calendar days after the donation's IST day, so these are the IST days from
 * DONATION_GAP_DAYS before windowStartMs's day up to DONATION_GAP_DAYS before today. Can take in
 * one day too many at the start; every candidate is checked exactly afterwards.
 * @returns {{ $gte: Date, $lt: Date }}
 */
const donationRangeEndingGapsBetween = (windowStartMs, nowMs) => ({
  $gte: new Date(indiaDayStartMs(toIndiaDayNumber(windowStartMs) - DONATION_GAP_DAYS)),
  $lt: new Date(indiaDayStartMs(toIndiaDayNumber(nowMs) - DONATION_GAP_DAYS + 1)),
});

/**
 * Available donors with a push subscription and a donation whose gap may have ended inside the
 * window.
 * Two index scans, never every user: fulfilled Requests by fulfilledAt (the { status, fulfilledAt,
 * matchedDonorId } index), and Users by lastOutsideDonationDate. A donor found by an older
 * donation may have donated again since; the caller reads their latest.
 */
const findReminderCandidates = async (windowStartMs, nowMs) => {
  const donationRange = donationRangeEndingGapsBetween(windowStartMs, nowMs);
  // null: a donor who deleted their account (see deleteAccount in user.controller.js)
  const inAppDonorIds = (
    await Request.distinct('matchedDonorId', { status: 'fulfilled', fulfilledAt: donationRange })
  ).filter(Boolean);

  return User.find({
    pushSubscription: { $ne: null },
    isAvailable: true,
    $or: [{ _id: { $in: inAppDonorIds } }, { lastOutsideDonationDate: donationRange }],
  })
    .select('_id pushSubscription lastOutsideDonationDate donationReminderSentFor')
    .lean();
};

// Only while the subscription is still the one the sweep read, so a new one the donor saved
// meanwhile is kept. Logged, never thrown: it is tidying after a send that already failed.
const clearPushSubscription = (userId, subscription) =>
  User.updateOne({ _id: userId, pushSubscription: subscription }, { $set: { pushSubscription: null } })
    .exec()
    .catch((error) => console.error('Failed to clear push subscription:', error.message));

/**
 * Reminds one candidate if their gap ended inside the window and this run claims it.
 * @returns {Promise<boolean>} whether this run claimed it and sent the push
 */
const remindCandidate = async (candidate, windowStartMs, nowMs) => {
  const latestDonationAt = await findLatestDonationAt(candidate._id, candidate.lastOutsideDonationDate);
  if (!latestDonationAt) return false;
  const eligibleAt = computeNextEligibleDonationAt(latestDonationAt);
  // Later than now: a newer donation started a new gap. Earlier than the window: too long ago.
  if (eligibleAt.getTime() > nowMs || eligibleAt.getTime() < windowStartMs) return false;
  // Already reminded for this moment: no write needed (the claim below would match nothing)
  if (candidate.donationReminderSentFor && candidate.donationReminderSentFor.getTime() >= eligibleAt.getTime()) {
    return false;
  }

  // Subscriptions stored before endpoint validation existed are re-checked before any send, as
  // request alerts do (sendNewRequestAlerts in request.controller.js)
  const endpointProblem = describePushEndpointProblem(candidate.pushSubscription.endpoint);
  if (endpointProblem) {
    console.error(`Skipped the donation reminder to donor ${candidate._id}: ${endpointProblem}`);
    await clearPushSubscription(candidate._id, candidate.pushSubscription);
    return false;
  }

  // The claim. $not also matches a donor never reminded (no field). Several sweeps can get this
  // far for one donor; the first write sets the moment, and every other one then matches nothing.
  // isAvailable again here: the donor may have switched it off since the candidates were read.
  const claimed = await User.findOneAndUpdate(
    {
      _id: candidate._id,
      pushSubscription: { $ne: null },
      isAvailable: true,
      donationReminderSentFor: { $not: { $gte: eligibleAt } },
    },
    { $set: { donationReminderSentFor: eligibleAt } },
    { returnDocument: 'after' }
  )
    .select('pushSubscription')
    .lean();
  if (!claimed) return false;

  // The subscription as of the claim, which may be newer than the candidate's
  try {
    await webpush.sendNotification(claimed.pushSubscription, buildDonationReminderPayload());
  } catch (error) {
    console.error(`Failed to send the donation reminder to donor ${candidate._id}:`, error.message);
    if (error.statusCode === 410 || error.statusCode === 404) {
      // Subscription expired or invalid, remove it
      await clearPushSubscription(candidate._id, claimed.pushSubscription);
    }
  }
  return true;
};

/**
 * Sends the reminders due at nowMs: one per donor whose gap ended in the last REMINDER_WINDOW_DAYS
 * and who has not had one for that moment. Sends nothing outside the reminder hours, or without
 * VAPID keys.
 *
 * Candidates are read first, then handled SWEEP_BATCH_SIZE at a time. A failed read or write stops
 * the run (it rejects with that error) once the rest of its batch has settled; a failed send does
 * not, and is only logged.
 *
 * @param {object} [options]
 * @param {number} [options.nowMs]
 * @returns {Promise<import('mongoose').Types.ObjectId[]>} the donors this run reminded
 */
const sendDonationReminders = async ({ nowMs = Date.now() } = {}) => {
  if (!isWebPushConfigured() || !isReminderHourInIndia(nowMs)) return [];

  const windowStartMs = nowMs - REMINDER_WINDOW_MS;
  const candidates = await findReminderCandidates(windowStartMs, nowMs);

  const remindedIds = [];
  for (let start = 0; start < candidates.length; start += SWEEP_BATCH_SIZE) {
    const batch = candidates.slice(start, start + SWEEP_BATCH_SIZE);
    const outcomes = await Promise.allSettled(batch.map((candidate) => remindCandidate(candidate, windowStartMs, nowMs)));
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    batch.forEach((candidate, index) => {
      if (outcomes[index].value) remindedIds.push(candidate._id);
    });
  }
  return remindedIds;
};

// For the timers and the reads, which must not fail: logs a failure and resolves to []
const sendDonationRemindersLogged = (options) =>
  sendDonationReminders(options).catch((error) => {
    console.error('Sending donation reminders failed:', error.message);
    return [];
  });

let sweepInFlight = null;
let lastSweepStartedAtMs = -Infinity;

// One sweep at a time in this process: the interval or a read arriving while a slow one still runs
// joins it. The claim keeps sweeps in other processes from sending twice.
const runReminderSweep = (nowMs = Date.now()) => {
  if (!sweepInFlight) {
    lastSweepStartedAtMs = nowMs;
    sweepInFlight = sendDonationRemindersLogged({ nowMs }).finally(() => {
      sweepInFlight = null;
    });
  }
  return sweepInFlight;
};

/**
 * The sweep checkAuth and getIncomingRequests start: at most once per LAZY_SWEEP_MIN_GAP_MS (the
 * startup and interval sweeps count too), joining one that is already running. Never rejects, so
 * a caller may leave it running without awaiting it; outside the reminder hours, or without VAPID
 * keys, it returns before reading anything.
 * @param {number} [nowMs]
 * @returns {Promise<import('mongoose').Types.ObjectId[]>} the donors it reminded, [] when skipped
 */
const sendDonationRemindersIfDue = (nowMs = Date.now()) => {
  if (sweepInFlight) return sweepInFlight;
  if (nowMs - lastSweepStartedAtMs < LAZY_SWEEP_MIN_GAP_MS) return Promise.resolve([]);
  return runReminderSweep(nowMs);
};

/**
 * Sweeps once now, then every SWEEP_INTERVAL_MS while the process runs. The interval is unref'd,
 * so it never keeps the process alive: shutdown (and Jest) can exit with it scheduled.
 * @returns {{ firstSweep: Promise<import('mongoose').Types.ObjectId[]>, stop: () => void }}
 */
const startDonationReminderSweeps = () => {
  const firstSweep = runReminderSweep();
  // A wrapper, so the timer's own arguments never reach runReminderSweep
  const timer = setInterval(() => runReminderSweep(), SWEEP_INTERVAL_MS);
  timer.unref();
  return { firstSweep, stop: () => clearInterval(timer) };
};

module.exports = {
  REMINDER_WINDOW_DAYS,
  REMINDER_FIRST_HOUR_IST,
  REMINDER_END_HOUR_IST,
  SWEEP_INTERVAL_MS,
  LAZY_SWEEP_MIN_GAP_MS,
  DONATION_REMINDER_NOTIFICATION,
  buildDonationReminderPayload,
  isReminderHourInIndia,
  sendDonationReminders,
  sendDonationRemindersIfDue,
  startDonationReminderSweeps,
};
