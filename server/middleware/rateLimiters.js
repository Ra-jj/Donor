const rateLimit = require('express-rate-limit');

/**
 * Limit login attempts per IP address to prevent brute-forcing.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per `window` (here, per 15 minutes)
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many login attempts, please try again later.',
    });
  },
  standardHeaders: true, 
  legacyHeaders: false, 
});

/**
 * Limit emergency requests per user (req.user._id) to prevent spam.
 */
const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each user to 5 requests per 15 minutes
  keyGenerator: (req) => {
    // protectRoute middleware guarantees req.user exists before this limiter hits
    return req.user._id.toString();
  },
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many emergency requests. Please wait a few minutes before requesting again.',
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const REGISTER_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Deliberately loose: mobile carriers in India put many users behind one IP (CGNAT)
const DEFAULT_REGISTER_LIMIT = 10;

/**
 * Works out the sign-up limiter's settings from the environment, once, at module load.
 *
 * - REGISTER_RATE_LIMIT_MAX set: that many sign-ups per IP per hour (must be a positive integer).
 * - Not set, NODE_ENV === 'test': skipped. Jest sets NODE_ENV=test, and test files register
 *   many users from 127.0.0.1. A test that sets REGISTER_RATE_LIMIT_MAX still gets the limiter.
 * - Not set otherwise (production, development): DEFAULT_REGISTER_LIMIT.
 */
const resolveRegisterLimitConfig = (env) => {
  const rawLimit = env.REGISTER_RATE_LIMIT_MAX;
  if (rawLimit === undefined || rawLimit === '') {
    return { limit: DEFAULT_REGISTER_LIMIT, skip: env.NODE_ENV === 'test' };
  }
  if (!/^\d+$/.test(rawLimit.trim()) || Number(rawLimit) < 1) {
    throw new Error(
      `REGISTER_RATE_LIMIT_MAX must be a positive integer, got ${JSON.stringify(rawLimit)}`
    );
  }
  return { limit: Number(rawLimit), skip: false };
};

const registerLimitConfig = resolveRegisterLimitConfig(process.env);

/**
 * Limit account creation per IP address, to slow down scripted sign-ups and email probing.
 * Every attempt counts, including ones that fail validation or hit an existing email.
 */
const registerLimiter = rateLimit({
  windowMs: REGISTER_WINDOW_MS,
  limit: registerLimitConfig.limit,
  skip: () => registerLimitConfig.skip,
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many accounts created from this network. Please try again later.',
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  loginLimiter,
  requestLimiter,
  registerLimiter,
  resolveRegisterLimitConfig,
  DEFAULT_REGISTER_LIMIT,
};
