const express = require('express');
const { getMessages, sendMessage } = require('../controllers/message.controller');
const protectRoute = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/:requestId', protectRoute, getMessages);
router.post('/send/:requestId', protectRoute, sendMessage);

module.exports = router;
