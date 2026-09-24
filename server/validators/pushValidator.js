const net = require('net');
const { z } = require('zod');

// The server POSTs to every stored endpoint (web-push), so only the browsers' own push
// services are accepted. Anything else could point the server at internal addresses.
const PUSH_SERVICE_HOST_ALLOWLIST = {
  exact: [
    'fcm.googleapis.com', // Chrome, Android and other Chromium browsers
    'updates.push.services.mozilla.com', // Firefox
    'web.push.apple.com', // Safari
  ],
  // Matched as a suffix, leading dot included, so "evilnotify.windows.com" does not match
  suffixes: [
    '.notify.windows.com', // Edge (Windows Push Notification Services)
  ],
};

const P256DH_KEY_BYTES = 65; // uncompressed P-256 public key
const AUTH_SECRET_BYTES = 16;

const isAllowedPushHost = (hostname) =>
  PUSH_SERVICE_HOST_ALLOWLIST.exact.includes(hostname) ||
  PUSH_SERVICE_HOST_ALLOWLIST.suffixes.some((suffix) => hostname.endsWith(suffix));

/**
 * Returns a message describing why the endpoint is not accepted, or null if it is accepted.
 * Uses the WHATWG URL parser, which lower-cases the host, drops a default :443 port and
 * normalises numeric host forms (e.g. "2130706433") to dotted IPv4.
 */
const describePushEndpointProblem = (endpoint) => {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return 'Push endpoint is not a valid URL';
  }

  if (url.protocol !== 'https:') return 'Push endpoint must use https';
  if (url.username !== '' || url.password !== '') {
    return 'Push endpoint must not contain credentials';
  }
  if (url.port !== '') return 'Push endpoint must use the default https port';

  // IPv6 literals keep their brackets in url.hostname; net.isIP only recognises them without
  const bareHost = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(bareHost) !== 0) return 'Push endpoint host must not be an IP address';

  if (!isAllowedPushHost(url.hostname)) return 'Push endpoint host is not an allowed push service';
  return null;
};

/**
 * Builds a check for an unpadded or padded base64url string that decodes to exactly
 * `byteLength` bytes. The re-encode comparison rejects strings Buffer would decode leniently.
 */
const base64UrlOfLength = (byteLength, label) =>
  z.string({ error: `${label} must be a base64url string` }).refine(
    (value) => {
      const unpadded = value.replace(/={1,2}$/, '');
      if (!/^[A-Za-z0-9_-]+$/.test(unpadded)) return false;
      const bytes = Buffer.from(unpadded, 'base64url');
      return bytes.length === byteLength && bytes.toString('base64url') === unpadded;
    },
    { error: `${label} must be base64url that decodes to ${byteLength} bytes` }
  );

const pushSubscriptionSchema = z.object(
  {
    endpoint: z
      .string({ error: 'Push endpoint must be a string' })
      .superRefine((endpoint, ctx) => {
        const problem = describePushEndpointProblem(endpoint);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }),
    expirationTime: z
      .number({ error: 'expirationTime must be a number or null' })
      .nullable()
      .optional(),
    keys: z.object(
      {
        p256dh: base64UrlOfLength(P256DH_KEY_BYTES, 'keys.p256dh'),
        auth: base64UrlOfLength(AUTH_SECRET_BYTES, 'keys.auth'),
      },
      { error: 'keys must be an object with p256dh and auth' }
    ),
  },
  { error: 'Invalid subscription object' }
);

module.exports = {
  pushSubscriptionSchema,
  describePushEndpointProblem,
};
