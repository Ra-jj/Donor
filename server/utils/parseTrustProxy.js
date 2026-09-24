// One hop: Express trusts only the proxy directly in front of it (Render's load balancer) and
// takes req.ip from the last X-Forwarded-For entry that proxy appended.
const DEFAULT_TRUST_PROXY = 1;

/**
 * Turns the TRUST_PROXY env var into a value for app.set('trust proxy', ...).
 *
 * - unset or empty      -> 1 (the default above)
 * - "0", "1", "2", ...   -> that number of trusted hops
 * - "true" / "false"     -> boolean (true trusts every hop, so any client can pick its own
 *                           req.ip; express-rate-limit logs ERR_ERL_PERMISSIVE_TRUST_PROXY for it)
 * - anything else        -> comma-separated list of IPs/subnets or Express's named ranges
 *                           ("loopback", "linklocal", "uniquelocal"). Express validates the list
 *                           in app.set() and throws on an entry it cannot parse.
 */
const parseTrustProxy = (rawValue) => {
  if (rawValue === undefined || rawValue === null) return DEFAULT_TRUST_PROXY;

  const value = String(rawValue).trim();
  if (value === '') return DEFAULT_TRUST_PROXY;
  if (/^\d+$/.test(value)) return Number(value);

  const lowered = value.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) {
    throw new Error(`TRUST_PROXY has no usable entries: ${JSON.stringify(rawValue)}`);
  }
  return entries;
};

module.exports = { parseTrustProxy, DEFAULT_TRUST_PROXY };
