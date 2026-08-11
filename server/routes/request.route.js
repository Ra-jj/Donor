const express = require('express');
const {
  createRequest,
  getMyRequests,
  getIncomingRequests,
  updateRequestStatus,
} = require('../controllers/request.controller');
const protectRoute = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/', protectRoute, createRequest);
router.get('/mine', protectRoute, getMyRequests);
router.get('/incoming', protectRoute, getIncomingRequests);
router.patch('/:id/status', protectRoute, updateRequestStatus);

module.exports = router;
