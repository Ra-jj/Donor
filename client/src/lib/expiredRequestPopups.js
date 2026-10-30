import toast from 'react-hot-toast';
import { getClosesAtMs, isExpiredRequest, describeExpiredRequest } from './requestExpiry';

// The popup a requester gets when one of their requests closes after its open hours: live, from
// the server's update over the socket, or on a later visit, for a request that closed while they
// were away (e.g. in the sweep that runs when the server wakes up, before they connect). Each
// request gets it once per device: the ids already shown are kept in localStorage, per user.

const DAY_MS = 24 * 60 * 60 * 1000;
// A request that closed longer ago than this gets no popup on a later visit. The first deploy
// closes every old open request at once, and a returning user should not get one popup for each.
const MISSED_POPUP_WINDOW_MS = 7 * DAY_MS;
// Only the newest ids are kept, so the stored set stays small
const MAX_SEEN_IDS = 50;

const seenStorageKey = (userId) => `donor:expired-seen:${userId}`;

// Ids shown since this page loaded. Without storage this is the only record, so a popup then shows
// at most once per page load.
const shownThisLoad = new Set();

// The stored ids, oldest first. None when storage is unavailable or holds something unexpected.
const readSeenIds = (userId) => {
  try {
    const stored = JSON.parse(localStorage.getItem(seenStorageKey(userId)) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const rememberShown = (userId, requestId) => {
  shownThisLoad.add(requestId);
  if (!userId) return;
  try {
    const ids = [...readSeenIds(userId).filter((id) => id !== requestId), requestId];
    localStorage.setItem(seenStorageKey(userId), JSON.stringify(ids.slice(-MAX_SEEN_IDS)));
  } catch {
    // Unavailable or full: shownThisLoad still keeps it to one popup on this page load
  }
};

/**
 * Shows the popup for one of this user's requests that closed after its open hours, and records
 * it as shown. Its id makes a second call for the same request replace the popup already up
 * rather than add another. wrap-anywhere lets a hospital name with no spaces wrap inside the
 * popup's 350px instead of running past its edge.
 * @param {string | undefined} userId
 * @param {string} requestId
 * @param {string | undefined} hospitalName
 */
export const announceExpiredRequest = (userId, requestId, hospitalName) => {
  toast(describeExpiredRequest(hospitalName), {
    id: `expired-${requestId}`,
    icon: '⌛',
    duration: 10000,
    className: 'wrap-anywhere',
  });
  rememberShown(userId, String(requestId));
};

// For a screen that already told the user (the success screen's note): no popup for it later
export const markExpiredRequestSeen = (userId, requestId) => rememberShown(userId, String(requestId));

/**
 * After this user's own requests load: the popup for each one that closed after its open hours
 * within the last MISSED_POPUP_WINDOW_MS and has not had it on this device yet.
 * @param {string | undefined} userId
 * @param {object[]} requests - from GET /requests/mine
 * @param {number} [nowMs]
 */
export const announceMissedExpiredRequests = (userId, requests, nowMs = Date.now()) => {
  if (!userId || !Array.isArray(requests)) return;
  const seenIds = new Set(readSeenIds(userId));
  requests
    .filter((req) => {
      const requestId = String(req._id);
      return (
        String(req.requesterId) === String(userId) &&
        isExpiredRequest(req) &&
        nowMs - getClosesAtMs(req.createdAt) <= MISSED_POPUP_WINDOW_MS &&
        !seenIds.has(requestId) &&
        !shownThisLoad.has(requestId)
      );
    })
    .forEach((req) => announceExpiredRequest(userId, req._id, req.hospitalName));
};
