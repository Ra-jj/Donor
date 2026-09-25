import { createElement, use } from 'react';

// Wraps a route page's dynamic import so the page gets its own chunk. Unlike React.lazy, whose
// first render always suspends (and React then keeps the fallback up for ~300 ms), a page made
// here renders straight away once its chunk is in, e.g. after preload() ran during the auth check,
// an idle prefetch or the previous page's exit animation.
export const lazyPage = (importPage) => {
  let pagePromise = null;

  // One import per page until the app is reloaded. A failed import stays failed, since browsers may
  // cache the failure anyway: recovery is a reload, which RouteErrorBoundary does once for a failed chunk.
  const preload = () => {
    if (!pagePromise) {
      const promise = importPage();
      // The status fields React's use() reads: once set, it returns the module (or throws the
      // error) synchronously instead of suspending
      promise.then(
        (module) => {
          promise.status = 'fulfilled';
          promise.value = module;
        },
        (error) => {
          promise.status = 'rejected';
          promise.reason = error;
        },
      );
      pagePromise = promise;
    }
    return pagePromise;
  };

  // use() on every render, even once loaded: React warns if a component that suspended in use()
  // stops calling it
  const LazyPage = (props) => {
    const { default: Page } = use(preload());
    return createElement(Page, props);
  };
  LazyPage.preload = preload;

  return LazyPage;
};
