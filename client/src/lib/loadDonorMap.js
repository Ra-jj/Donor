import { runWhenIdle } from './runWhenIdle';

// DonorMap has its own chunk (Leaflet is large), but unlike a page it is shown without a route
// change, so the page never reloads into a new build before it loads. Once a new build's service
// worker takes over, this build's copy of the chunk is gone from its cache and from the server,
// and the map could only fail. The pages that show it load it early, while that copy is still there.
export const loadDonorMap = () => import('../components/DonorMap');

// For the mount effect of a page that shows the map: loads it at an idle moment, so it does not
// hold up the page's own data. Returns the effect's cleanup. A failed load needs no handling here:
// showing the map imports it again, and MapErrorBoundary covers a failure then.
export const preloadDonorMapWhenIdle = () =>
  runWhenIdle(() => {
    loadDonorMap().catch(() => {});
  });
