const express = require('express');
const {
  createRequest,
  getMyRequests,
  getIncomingRequests,
  updateRequestStatus,
  fulfillRequest,
  rateRequest,
} = require('../controllers/request.controller');
const protectRoute = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { requestLimiter } = require('../middleware/rateLimiters');
const { createRequestSchema, rateRequestSchema } = require('../validators/requestValidator');

const router = express.Router();

router.post('/', protectRoute, requestLimiter, validate(createRequestSchema), createRequest);
router.get('/mine', protectRoute, getMyRequests);
router.get('/incoming', protectRoute, getIncomingRequests);
router.patch('/:id/status', protectRoute, updateRequestStatus);
router.patch('/:id/fulfill', protectRoute, fulfillRequest);
router.post('/:id/rate', protectRoute, validate(rateRequestSchema), rateRequest);

module.exports = router;
