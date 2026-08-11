const express = require('express');
const { register, login, logout, checkAuth } = require('../controllers/auth.controller');
const protectRoute = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.get('/check', protectRoute, checkAuth);

module.exports = router;
