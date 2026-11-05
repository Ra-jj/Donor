const express = require('express');
const {
  createRequest,
  getMyRequests,
  getIncomingRequests,
  updateRequestStatus,
  fulfillRequest,
  rateRequest,
  getShareLink,
} = require('../controllers/request.controller');
const { reportRequest, reportUser } = require('../controllers/report.controller');
const { blockFromRequest } = require('../controllers/block.controller');
const protectRoute = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const validateObjectIdParam = require('../middleware/validateObjectId.middleware');
const { requestLimiter, reportLimiter, blockLimiter } = require('../middleware/rateLimiters');
const {
  createRequestSchema,
  rateRequestSchema,
  updateRequestStatusSchema,
} = require('../validators/requestValidator');
const { reportRequestSchema, reportUserSchema } = require('../validators/reportValidator');

const router = express.Router();

router.post('/', protectRoute, requestLimiter, validate(createRequestSchema), createRequest);
router.get('/mine', protectRoute, getMyRequests);
router.get('/incoming', protectRoute, getIncomingRequests);
// Every /:id route checks the id right after auth: 401 first, then 400 for a malformed id
const validateRequestId = validateObjectIdParam('id');

router.patch('/:id/status', protectRoute, validateRequestId, validate(updateRequestStatusSchema), updateRequestStatus);
router.patch('/:id/fulfill', protectRoute, validateRequestId, fulfillRequest);
router.post('/:id/rate', protectRoute, validateRequestId, validate(rateRequestSchema), rateRequest);
// The token of the requester's own share link, made on the first call (see getShareLink)
router.post('/:id/share-link', protectRoute, validateRequestId, getShareLink);
// Report this request; report or block the other person on it (report.controller.js, block.controller.js)
router.post('/:id/report', protectRoute, validateRequestId, reportLimiter, validate(reportRequestSchema), reportRequest);
router.post('/:id/report-user', protectRoute, validateRequestId, reportLimiter, validate(reportUserSchema), reportUser);
router.post('/:id/block', protectRoute, validateRequestId, blockLimiter, blockFromRequest);

module.exports = router;
