import { registerSW } from 'virtual:pwa-register';
import { reloadPage } from './pageReload';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Set once a new build's service worker controls this page, which still runs the old build. The
// page then reloads at the first moment that loses nothing: the next route change (leaving a page
// drops its state anyway), or going to the background while the page shown is still unused.
let hasNewBuildTakenOver = false;
// Whether the user clicked or typed on the page shown since its route opened. A reload would undo
// that (a half-typed form or message, an open conversation, a sent request's result screen), so
// a used page waits for a route change instead of reloading when the user switches apps.
let hasUserUsedPage = false;

// Offline the reload could only end on the browser's error page, so stay on the old build for now
const reloadForNewBuild = () => {
  if (navigator.onLine) reloadPage();
};

const reloadIfInBackgroundAndUnused = () => {
  if (hasNewBuildTakenOver && !hasUserUsedPage && document.hidden) reloadForNewBuild();
};

const handleNewBuildTakeover = () => {
  hasNewBuildTakenOver = true;
  // A page that is in the background already, e.g. a second open copy of the app
  reloadIfInBackgroundAndUnused();
};

// App calls this on every route change
export const reloadForNewBuildOnRouteChange = () => {
  if (hasNewBuildTakenOver) reloadForNewBuild();
  hasUserUsedPage = false;
};

const checkForUpdate = (registration) => {
  // Offline the check can only fail
  if (!navigator.onLine) return;
  registration.update().catch((error) => console.warn('Service worker update check failed:', error));
};

export const registerServiceWorker = () => {
  if (!('serviceWorker' in navigator)) return;

  // The first install also changes the controller (from none, through clients.claim() in sw.js),
  // but this page is that build already: only a change from an earlier controller is a new build
  let currentController = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const previousController = currentController;
    currentController = navigator.serviceWorker.controller;
    if (previousController) handleNewBuildTakeover();
  });

  const markPageUsed = () => {
    hasUserUsedPage = true;
  };
  document.addEventListener('click', markPageUsed, { capture: true, passive: true });
  document.addEventListener('input', markPageUsed, { capture: true, passive: true });
  document.addEventListener('visibilitychange', reloadIfInBackgroundAndUnused);

  registerSW({
    immediate: true,
    // Without this, registerType 'autoUpdate' reloads the page the moment a new worker activates,
    // even mid-typing. It also covers a page opened with no controller (a hard reload), which the
    // controllerchange check above ignores, once a build found over a minute later takes over.
    onNeedReload: handleNewBuildTakeover,
    onRegisteredSW: (_swUrl, registration) => {
      if (!registration) return;
      // Route changes in a single-page app never make the browser check sw.js, so check when the
      // user comes back to the app, and hourly while it stays open
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkForUpdate(registration);
      });
      setInterval(() => checkForUpdate(registration), UPDATE_CHECK_INTERVAL_MS);
    },
    onRegisterError: (error) => console.error('Service worker registration failed:', error),
  });
};
