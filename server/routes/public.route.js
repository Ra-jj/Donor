const express = require('express');
const { getSharedRequest } = require('../controllers/request.controller');
const { getPublicStats } = require('../controllers/publicStats.controller');
const { publicRequestLimiter, publicStatsLimiter } = require('../middleware/rateLimiters');
const { isShareTokenFormat } = require('../utils/shareToken');

// Routes anyone can call without an account. Mounted at /api/public.
const router = express.Router();

// On every answer from here, errors and 429s included. no-store: a request's state changes, and
// a shared phone or a proxy must not keep a copy. noindex: a link that reaches a search engine
// (posted on a public page, say) must not put the request in its results. The home page's totals
// replace no-store on their successful answer only (controllers/publicStats.controller.js).
router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  next();
});

// The limiter counts every call, so badly formed tokens use up the allowance too
router.get('/requests/:token', publicRequestLimiter, (req, res, next) => {
  if (!isShareTokenFormat(req.params.token)) {
    return res.status(400).json({ message: 'Invalid link' });
  }
  next();
}, getSharedRequest);

// The home page's two totals, counts only
router.get('/stats', publicStatsLimiter, getPublicStats);

module.exports = router;
