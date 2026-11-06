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

/**
 * Limit account deletion attempts per user (req.user._id). Each attempt checks the current
 * password, so without this a stolen session could be used to guess the password.
 * Per user rather than per IP: many users share one IP on Indian mobile networks (CGNAT).
 */
const deleteAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5,
  keyGenerator: (req) => {
    // protectRoute middleware guarantees req.user exists before this limiter hits
    return req.user._id.toString();
  },
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many attempts to delete your account. Please try again in 15 minutes.',
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Limit reports per user (req.user._id): of requests and of users, together. A real report is
 * rare, so this only slows down someone filing them in bulk. Per user, as above, not per IP.
 */
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  keyGenerator: (req) => {
    // protectRoute middleware guarantees req.user exists before this limiter hits
    return req.user._id.toString();
  },
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many reports. Please try again in an hour.',
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Limit blocks and unblocks per user (req.user._id), together. A block can end a match, and the
 * request then goes back to nearby donors with a new alert, so blocking and unblocking in a loop
 * must not be able to alert them again and again.
 */
const blockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,
  keyGenerator: (req) => {
    // protectRoute middleware guarantees req.user exists before this limiter hits
    return req.user._id.toString();
  },
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many blocks or unblocks. Please try again in 15 minutes.',
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

/**
 * Limit reads of shared request pages (GET /api/public/requests/:token) per IP address. Anyone can
 * call it without an account, so this caps how fast one address can try tokens or load the
 * database. Loose on purpose: everyone who opens a link shared in one WhatsApp group may come
 * through the same mobile network IP (CGNAT), and each page view is one call.
 */
const publicRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300,
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many requests from this network. Please wait a few minutes and try again.',
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Limit reads of the home page's totals (GET /api/public/stats) per IP address. They come from a
 * copy in memory (controllers/publicStats.controller.js), so this only stops one address from
 * hammering the server. As loose as the one above, and a separate count, so loading the home
 * page never uses up anyone's allowance for opening shared links.
 */
const publicStatsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300,
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many requests from this network. Please wait a few minutes and try again.',
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  loginLimiter,
  requestLimiter,
  deleteAccountLimiter,
  reportLimiter,
  blockLimiter,
  registerLimiter,
  publicRequestLimiter,
  publicStatsLimiter,
  resolveRegisterLimitConfig,
  DEFAULT_REGISTER_LIMIT,
};
