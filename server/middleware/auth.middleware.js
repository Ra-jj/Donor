const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/user.model');
const { AUTH_COOKIE_NAME } = require('../utils/authCookie');

const INVALID_TOKEN_MESSAGE = 'Unauthorized - Invalid Token';

const rejectUnauthorized = (res, observedFact, message = INVALID_TOKEN_MESSAGE) => {
  console.warn(`protectRoute rejected: ${observedFact}`);
  return res.status(401).json({ message });
};

const protectRoute = async (req, res, next) => {
  const token = req.cookies && req.cookies[AUTH_COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ message: 'Unauthorized - No Token Provided' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    // TokenExpiredError and NotBeforeError are subclasses of JsonWebTokenError, so this one
    // check covers all three. error.message is the library's own text, e.g. 'jwt expired'.
    if (error instanceof jwt.JsonWebTokenError) {
      return rejectUnauthorized(res, `token verification failed: ${error.message}`);
    }
    console.error('Error in protectRoute middleware: jwt.verify threw:', error.message);
    return res.status(500).json({ message: 'Internal Server Error' });
  }

  // A payload without a usable userId would make findById throw a CastError (a 500)
  if (!decoded || !mongoose.isValidObjectId(decoded.userId)) {
    return rejectUnauthorized(res, 'token userId is not a valid ObjectId');
  }

  try {
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      return rejectUnauthorized(
        res,
        "no user exists for the token's userId",
        'Unauthorized - User not found'
      );
    }

    req.user = user;
  } catch (error) {
    console.error('Error in protectRoute middleware: user lookup threw:', error.message);
    return res.status(500).json({ message: 'Internal Server Error' });
  }

  // Outside the try, so an error thrown by a later handler is not reported as an auth failure
  return next();
};

module.exports = protectRoute;
