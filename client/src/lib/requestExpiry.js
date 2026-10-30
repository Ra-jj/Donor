// Display helpers for the hours a request stays open. The server closes a pending request once
// they are up (server/utils/requestExpiry.js): it becomes 'cancelled' with closedReason 'expired'.
// Nothing here changes what the server allows.

// Same value as the server's REQUEST_OPEN_HOURS; server/tests/requestExpiry.test.js checks it
export const REQUEST_OPEN_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;

// When a request created at createdAt (an ISO string or Date) closes, in milliseconds
export const getClosesAtMs = (createdAt) => new Date(createdAt).getTime() + REQUEST_OPEN_HOURS * HOUR_MS;

// A pending request whose hours are up on this device's clock, which the server may not have closed yet
export const hasRunOut = (request, nowMs) => request.status === 'pending' && getClosesAtMs(request.createdAt) <= nowMs;

export const isExpiredRequest = (request) => request?.status === 'cancelled' && request.closedReason === 'expired';

// e.g. "Open for 31 more hours". Whole hours, rounded down, so it never promises more time than is left.
export const describeTimeLeft = (closesAtMs, nowMs) => {
  const msLeft = closesAtMs - nowMs;
  if (msLeft <= 0) return 'Closing now';
  const hoursLeft = Math.floor(msLeft / HOUR_MS);
  if (hoursLeft < 1) return 'Open for less than an hour';
  return `Open for ${hoursLeft} more ${hoursLeft === 1 ? 'hour' : 'hours'}`;
};

export const EXPIRED_NOTE = `Closed after ${REQUEST_OPEN_HOURS} hours with no donor.`;

export const describeExpiredRequest = (hospitalName) =>
  `Your request ${hospitalName ? `at ${hospitalName} ` : ''}closed after ${REQUEST_OPEN_HOURS} hours with no donor. If you still need blood, create a new request.`;
