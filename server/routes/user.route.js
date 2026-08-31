const express = require('express');
const { getStats, updateProfile, getHistory } = require('../controllers/user.controller');
const protectRoute = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { updateProfileSchema } = require('../validators/profileValidator');

const router = express.Router();

router.get('/stats', protectRoute, getStats);
router.get('/history', protectRoute, getHistory);
router.patch('/profile', protectRoute, validate(updateProfileSchema), updateProfile);

module.exports = router;
