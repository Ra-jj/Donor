const express = require('express');
const { getStats, updateProfile, getHistory, deleteAccount } = require('../controllers/user.controller');
const protectRoute = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { deleteAccountLimiter } = require('../middleware/rateLimiters');
const { updateProfileSchema } = require('../validators/profileValidator');
const { deleteAccountSchema } = require('../validators/authValidator');

const router = express.Router();

router.get('/stats', protectRoute, getStats);
router.get('/history', protectRoute, getHistory);
router.patch('/profile', protectRoute, validate(updateProfileSchema), updateProfile);
router.delete('/me', protectRoute, deleteAccountLimiter, validate(deleteAccountSchema), deleteAccount);

module.exports = router;
