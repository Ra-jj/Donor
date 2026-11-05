const express = require('express');
const { getStats, updateProfile, getHistory, deleteAccount, recordPrivacyConsent } = require('../controllers/user.controller');
const { getBlockedUsers, unblockUser } = require('../controllers/block.controller');
const protectRoute = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const validateObjectIdParam = require('../middleware/validateObjectId.middleware');
const { deleteAccountLimiter, blockLimiter } = require('../middleware/rateLimiters');
const { updateProfileSchema } = require('../validators/profileValidator');
const { deleteAccountSchema, privacyConsentSchema } = require('../validators/authValidator');

const router = express.Router();

router.get('/stats', protectRoute, getStats);
router.get('/history', protectRoute, getHistory);
router.patch('/profile', protectRoute, validate(updateProfileSchema), updateProfile);
router.post('/privacy-consent', protectRoute, validate(privacyConsentSchema), recordPrivacyConsent);
router.delete('/me', protectRoute, deleteAccountLimiter, validate(deleteAccountSchema), deleteAccount);
// The caller's own blocks (block.controller.js). The id is the block's, checked right after auth.
router.get('/blocks', protectRoute, getBlockedUsers);
router.delete('/blocks/:blockId', protectRoute, validateObjectIdParam('blockId', 'block'), blockLimiter, unblockUser);

module.exports = router;
