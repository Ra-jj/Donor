// A failed dynamic import in Chrome ("Failed to fetch dynamically imported module"), Firefox
// ("error loading dynamically imported module") and Safari ("Importing a module script failed.",
// or a MIME type message), and Vite's own "Unable to preload CSS" for a chunk's stylesheet
export const isChunkLoadError = (error) =>
  /dynamically imported module|Importing a module script failed|not a valid JavaScript MIME type|Unable to preload CSS/i
    .test(error?.message ?? '');
