import { Component } from 'react';
import { WarningCircleIcon } from '@phosphor-icons/react';
import { isChunkLoadError } from '../lib/chunkLoadError';

const LAST_CHUNK_RELOAD_KEY = 'donor:lastChunkReloadAt';
const CHUNK_RELOAD_COOLDOWN_MS = 60 * 1000;

// After a deploy, a page opened before it still asks for the old build's chunk names, which the
// server no longer has; a reload picks up the new build. Offline a reload can only fail. At most
// one automatic reload a minute, so a chunk that keeps failing ends on the error screen instead
// of looping. Returns whether it reloads.
const reloadForNewBuild = () => {
  if (!navigator.onLine) return false;
  try {
    const lastReloadAt = Number(sessionStorage.getItem(LAST_CHUNK_RELOAD_KEY));
    if (Date.now() - lastReloadAt < CHUNK_RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(LAST_CHUNK_RELOAD_KEY, String(Date.now()));
  } catch (error) {
    // Without storage there is no loop guard, so leave it to the Reload button
    console.warn('Not reloading after a failed chunk load: sessionStorage is unavailable', error);
    return false;
  }
  window.location.reload();
  return true;
};

// Catches a page that fails to render, most often because its chunk failed to load (offline on a
// first visit, or removed by a deploy), so the Navbar stays usable instead of the whole app going
// blank. Only a page that is actually shown reloads: a failed idle prefetch just stays failed
// until that page is opened. React logs the caught error itself.
class RouteErrorBoundary extends Component {
  state = { error: null, isReloading: false };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // setState here re-renders before the browser paints, so the error screen never flashes
    if (isChunkLoadError(error) && reloadForNewBuild()) this.setState({ isReloading: true });
  }

  render() {
    const { error, isReloading } = this.state;
    if (!error) return this.props.children;

    if (isReloading) {
      return (
        <div className="flex items-center justify-center min-h-[50vh]">
          <span className="loading loading-spinner loading-lg text-primary"></span>
        </div>
      );
    }

    return (
      <div className="container mx-auto px-4 py-16 max-w-md">
        <div className="bg-base-100 border border-base-300 rounded-3xl p-8 shadow-sm flex flex-col items-center text-center">
          <WarningCircleIcon weight="duotone" className="w-12 h-12 text-error mb-4" />
          <h2 className="text-2xl font-display font-bold text-base-content mb-2">
            This page didn't load
          </h2>
          <p className="text-base-content/70 mb-6">
            {isChunkLoadError(error)
              ? 'Check your connection, then reload to get the latest version of Donor.'
              : 'Something went wrong on this page. Reload to try again.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="btn btn-primary rounded-full px-8 text-white font-bold active:scale-95 transition-transform min-h-11"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}

export default RouteErrorBoundary;
