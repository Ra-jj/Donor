const express = require('express');
const { getMessages, sendMessage } = require('../controllers/message.controller');
const protectRoute = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { sendMessageSchema } = require('../validators/messageValidator');

const router = express.Router();

router.get('/:requestId', protectRoute, getMessages);
router.post('/send/:requestId', protectRoute, validate(sendMessageSchema), sendMessage);

module.exports = router;
