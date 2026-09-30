let hasReloadStarted = false;

// The one way the app reloads itself: for a new build's service worker (serviceWorkerUpdate.js)
// or for a failed chunk (RouteErrorBoundary). Whichever asks first reloads; a second request from
// the same page does nothing, so the two can never both reload or undo each other's loop guard.
export const reloadPage = () => {
  if (hasReloadStarted) return;
  hasReloadStarted = true;
  window.location.reload();
};

export const isPageReloading = () => hasReloadStarted;
