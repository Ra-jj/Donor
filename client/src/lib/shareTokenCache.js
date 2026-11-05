// Share tokens (lib/shareRequest.js) already fetched on this page load, by request id. The share
// buttons (components/ShareRequestButtons.jsx) are mounted again each time the dashboard's My
// Requests list is shown, and a request's token never changes, so each is asked for once. Emptied on
// logout (store/useAuthStore.js). Other sign-outs leave it until the page reloads, which is safe:
// the buttons only ever ask for the signed-in user's own request ids.
const shareTokenByRequestId = new Map();

export const getCachedShareToken = (requestId) => shareTokenByRequestId.get(String(requestId)) ?? null;

export const cacheShareToken = (requestId, shareToken) => {
  shareTokenByRequestId.set(String(requestId), shareToken);
};

export const clearShareTokenCache = () => {
  shareTokenByRequestId.clear();
};
