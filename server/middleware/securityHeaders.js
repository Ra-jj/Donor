const helmet = require('helmet');

/**
 * Content-Security-Policy directives for the API and for the built client in client/dist.
 * Every origin below was found in client/index.html, client/src or the built bundle:
 * - Google Fonts: the stylesheet link in index.html and the font files it loads
 * - OpenStreetMap tiles (DonorMap.jsx TileLayer) and Nominatim search (RegisterPage.jsx fetch)
 * - socket.io on the same origin, over ws:/wss:
 * - Leaflet: style attributes in divIcon HTML and data: images in leaflet.css
 * The build has no inline scripts: the theme bootstrap is client/public/theme-init.js and the
 * service worker is registered from the bundled virtual:pwa-register module.
 */
const buildCspDirectives = ({ isProduction }) => ({
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https://tile.openstreetmap.org'],
  connectSrc: ["'self'", 'ws:', 'wss:', 'https://nominatim.openstreetmap.org'],
  workerSrc: ["'self'"],
  manifestSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  // Only production is served over https (Render). Over plain http, e.g. a local run of the
  // built client, this directive would rewrite same-origin asset URLs to https and break them.
  // null removes helmet's default for it.
  upgradeInsecureRequests: isProduction ? [] : null,
});

const createSecurityHeaders = ({ isProduction }) =>
  helmet({
    contentSecurityPolicy: {
      // Keeps helmet's other defaults: form-action 'self' and script-src-attr 'none'
      useDefaults: true,
      directives: buildCspDirectives({ isProduction }),
    },
    // Tiles from tile.openstreetmap.org carry no Cross-Origin-Resource-Policy header, so
    // require-corp would block them. helmet 8 already leaves this off; stated for clarity.
    crossOriginEmbedderPolicy: false,
    // helmet's default is no-referrer. The OpenStreetMap tile and Nominatim usage policies
    // ask browser apps to send a Referer, and this policy sends only the origin cross-site.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

module.exports = { createSecurityHeaders, buildCspDirectives };
