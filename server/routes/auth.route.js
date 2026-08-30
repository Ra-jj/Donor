const express = require('express');
const { register, login, logout, checkAuth } = require('../controllers/auth.controller');
const protectRoute = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { loginLimiter } = require('../middleware/rateLimiters');
const { registerSchema, loginSchema } = require('../validators/authValidator');

const router = express.Router();

router.post('/register', validate(registerSchema), register);
router.post('/login', loginLimiter, validate(loginSchema), login);
router.post('/logout', logout);
router.get('/check', protectRoute, checkAuth);

module.exports = router;
