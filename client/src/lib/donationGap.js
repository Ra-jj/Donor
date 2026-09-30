// Display helpers for the minimum time between donations. The server decides who may donate
// (server/utils/donationGap.js) and sends nextEligibleDonationAt: 00:00 in India on the first day
// the donor may donate again, or null. Nothing here changes what the server allows.

// Same value as the server's DONATION_GAP_DAYS, used only in the explanation text
export const DONATION_GAP_DAYS = 120;

// Donation days are calendar days in India, so dates are shown in India's time zone even when
// the browser is set to another one. Otherwise 00:00 in India would show as the day before.
const INDIA_TIME_ZONE = 'Asia/Kolkata';
const INDIA_UTC_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export const isInDonationGap = (nextEligibleDonationAt) =>
  Boolean(nextEligibleDonationAt) && new Date(nextEligibleDonationAt).getTime() > Date.now();

// e.g. "1 May 2026"
export const formatIndiaDate = (instant) =>
  new Date(instant).toLocaleDateString('en-IN', {
    timeZone: INDIA_TIME_ZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

// Today in India as YYYY-MM-DD, the format of an <input type="date"> value
export const getTodayInIndiaDateString = () =>
  new Date(Date.now() + INDIA_UTC_OFFSET_MS).toISOString().slice(0, 10);

// The server stores the outside donation date as 00:00 UTC of the chosen day, so its first ten
// characters are that day in YYYY-MM-DD
export const toDateInputValue = (storedDate) => (storedDate ? String(storedDate).slice(0, 10) : '');
