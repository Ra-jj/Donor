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

module.exports = {
  loginLimiter,
  requestLimiter,
};
