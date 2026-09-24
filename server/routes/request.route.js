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
const validateObjectIdParam = require('../middleware/validateObjectId.middleware');
const { requestLimiter } = require('../middleware/rateLimiters');
const {
  createRequestSchema,
  rateRequestSchema,
  updateRequestStatusSchema,
} = require('../validators/requestValidator');

const router = express.Router();

router.post('/', protectRoute, requestLimiter, validate(createRequestSchema), createRequest);
router.get('/mine', protectRoute, getMyRequests);
router.get('/incoming', protectRoute, getIncomingRequests);
// Every /:id route checks the id right after auth: 401 first, then 400 for a malformed id
const validateRequestId = validateObjectIdParam('id');

router.patch('/:id/status', protectRoute, validateRequestId, validate(updateRequestStatusSchema), updateRequestStatus);
router.patch('/:id/fulfill', protectRoute, validateRequestId, fulfillRequest);
router.post('/:id/rate', protectRoute, validateRequestId, validate(rateRequestSchema), rateRequest);

module.exports = router;
