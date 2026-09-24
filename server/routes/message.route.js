const express = require('express');
const { getMessages, sendMessage } = require('../controllers/message.controller');
const protectRoute = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const validateObjectIdParam = require('../middleware/validateObjectId.middleware');
const { sendMessageSchema } = require('../validators/messageValidator');

const router = express.Router();

// Every /:requestId route checks the id right after auth: 401 first, then 400 for a malformed id
const validateRequestId = validateObjectIdParam('requestId');

router.get('/:requestId', protectRoute, validateRequestId, getMessages);
router.post('/send/:requestId', protectRoute, validateRequestId, validate(sendMessageSchema), sendMessage);

module.exports = router;
