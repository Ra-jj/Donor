// requestIdleCallback is missing in Safari, so fall back to a short timeout there. Returns a
// function that cancels the callback if it has not run yet.
export const runWhenIdle = (callback) => {
  if ('requestIdleCallback' in window) {
    const handle = window.requestIdleCallback(callback, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, 1000);
  return () => clearTimeout(handle);
};
