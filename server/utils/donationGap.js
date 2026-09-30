/**
 * Minimum time between whole-blood donations.
 *
 * Nothing about the gap is stored. A donor's last donation is the more recent of:
 *   - their latest Request with status 'fulfilled', matchedDonorId = them, read by fulfilledAt
 *     (the same derive-from-Requests approach as "busy", see isAvailable in user.model.js), and
 *   - User.lastOutsideDonationDate, a donation they report making outside the app.
 *
 * Days are calendar days in India (IST, UTC+5:30, no daylight saving). A donation on IST
 * calendar day D allows the next one from 00:00 IST on day D + DONATION_GAP_DAYS, whatever
 * the time of day of either. So the date shown to the donor and the moment the server lets
 * them in are the same, and the server never lets them in on an earlier calendar day.
 * Everything here uses fixed offsets, never the server's local time zone (Render runs in UTC).
 */
const Request = require('../models/request.model');

// Drugs and Cosmetics (Second Amendment) Rules, 2020, G.S.R. 166(E) of 11 March 2020,
// Schedule F Part XII-B, "H. Criteria for Blood Donation", item 4 "Donation Interval": whole
// blood "once in three months (90 days) for males and four months (120 days) for females".
// The app does not store sex, so every donor gets the longer interval.
const DONATION_GAP_DAYS = 120;

const DAY_MS = 24 * 60 * 60 * 1000;
const INDIA_UTC_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const INDIA_TIME_ZONE = 'Asia/Kolkata';

// Days since 1970-01-01 on the IST calendar, for an instant in milliseconds
const toIndiaDayNumber = (instantMs) => Math.floor((instantMs + INDIA_UTC_OFFSET_MS) / DAY_MS);

// The instant 00:00 IST starts an IST calendar day
const indiaDayStartMs = (dayNumber) => dayNumber * DAY_MS - INDIA_UTC_OFFSET_MS;

/**
 * Today's date in India as YYYY-MM-DD, the format an <input type="date"> sends.
 * @param {number} [nowMs]
 * @returns {string}
 */
const getTodayInIndiaDateString = (nowMs = Date.now()) =>
  new Date(nowMs + INDIA_UTC_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The earliest donation instant that still blocks donating at nowMs: 00:00 IST on the IST
 * calendar day DONATION_GAP_DAYS - 1 days before today. A donation at or after it is in the gap.
 * @param {number} [nowMs]
 * @returns {Date}
 */
const getDonationGapCutoff = (nowMs = Date.now()) =>
  new Date(indiaDayStartMs(toIndiaDayNumber(nowMs) - (DONATION_GAP_DAYS - 1)));

/**
 * 00:00 IST on the day DONATION_GAP_DAYS after the IST calendar day of the donation.
 * For any instant now: now < this result exactly when donationAt >= getDonationGapCutoff(now).
 * @param {Date} donationAt
 * @returns {Date}
 */
const computeNextEligibleDonationAt = (donationAt) =>
  new Date(indiaDayStartMs(toIndiaDayNumber(donationAt.getTime()) + DONATION_GAP_DAYS));

// Request filter: donations completed through the app that are still inside the gap.
// A fulfilled request without fulfilledAt never matches ($gte skips null): every fulfil has
// set fulfilledAt since the status was added, and an unknown date cannot start a gap.
const inAppDonationInGapFilter = (cutoff) => ({ status: 'fulfilled', fulfilledAt: { $gte: cutoff } });

// User filter: no outside donation inside the gap. $not also matches a null value and documents
// that do not have the field at all. A field-level condition, not a top-level $or, so a caller
// can spread it into a query that has its own $or without one overwriting the other.
const noOutsideDonationInGapFilter = (cutoff) => ({
  lastOutsideDonationDate: { $not: { $gte: cutoff } },
});

const isValidDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

/**
 * When the donor may donate again, or null if they may donate now.
 * Uses the same filters as createRequest's candidate query, so the two always agree.
 * @param {import('mongoose').Types.ObjectId|string} donorId
 * @param {Date|null|undefined} lastOutsideDonationDate - the donor's stored field, read fresh by the caller
 * @param {object} [options]
 * @param {import('mongoose').Types.ObjectId} [options.excludeRequestId] - a request that must not
 *   count as a donation (acceptRequest's own request, which its requester may fulfil at any moment)
 * @param {number} [options.nowMs]
 * @returns {Promise<Date|null>}
 */
const findNextEligibleDonationAt = async (
  donorId,
  lastOutsideDonationDate,
  { excludeRequestId = null, nowMs = Date.now() } = {}
) => {
  const cutoff = getDonationGapCutoff(nowMs);

  const inAppDonationQuery = { matchedDonorId: donorId, ...inAppDonationInGapFilter(cutoff) };
  if (excludeRequestId) inAppDonationQuery._id = { $ne: excludeRequestId };
  const latestInAppDonation = await Request.findOne(inAppDonationQuery)
    .sort({ fulfilledAt: -1 })
    .select('fulfilledAt')
    .lean();

  const donationsInGap = [];
  if (latestInAppDonation) donationsInGap.push(latestInAppDonation.fulfilledAt.getTime());
  if (isValidDate(lastOutsideDonationDate) && lastOutsideDonationDate.getTime() >= cutoff.getTime()) {
    donationsInGap.push(lastOutsideDonationDate.getTime());
  }
  if (donationsInGap.length === 0) return null;

  return computeNextEligibleDonationAt(new Date(Math.max(...donationsInGap)));
};

/**
 * A date as the donor reads it in India, e.g. "1 May 2026".
 * @param {Date} date
 * @returns {string}
 */
const formatIndiaDate = (date) =>
  date.toLocaleDateString('en-IN', { timeZone: INDIA_TIME_ZONE, day: 'numeric', month: 'long', year: 'numeric' });

/**
 * @param {Date} nextEligibleDonationAt
 * @returns {string}
 */
const describeDonationGap = (nextEligibleDonationAt) =>
  `You donated recently. You can donate again from ${formatIndiaDate(nextEligibleDonationAt)}.`;

/**
 * The user as the client receives it (no password), plus nextEligibleDonationAt
 * (an ISO instant, 00:00 IST of the first day they may donate, or null).
 * @param {import('mongoose').Document} userDocument
 * @returns {Promise<object>}
 */
const withDonationEligibility = async (userDocument) => {
  const user = userDocument.toObject();
  delete user.password;
  user.nextEligibleDonationAt = await findNextEligibleDonationAt(userDocument._id, userDocument.lastOutsideDonationDate);
  return user;
};

module.exports = {
  DONATION_GAP_DAYS,
  getTodayInIndiaDateString,
  getDonationGapCutoff,
  computeNextEligibleDonationAt,
  inAppDonationInGapFilter,
  noOutsideDonationInGapFilter,
  findNextEligibleDonationAt,
  formatIndiaDate,
  describeDonationGap,
  withDonationEligibility,
};
