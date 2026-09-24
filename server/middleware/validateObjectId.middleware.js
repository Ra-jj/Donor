const mongoose = require('mongoose');

/**
 * Express middleware factory: rejects a malformed ObjectId in req.params[paramName]
 * with 400 before any DB call, instead of letting Mongoose throw a CastError (500).
 *
 * Mount it AFTER protectRoute so an anonymous caller still gets 401, whatever the id.
 * (router.param would run before protectRoute, so it is deliberately not used here.)
 */
const validateObjectIdParam = (paramName) => (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params[paramName])) {
    return res.status(400).json({ message: 'Invalid request id' });
  }
  next();
};

module.exports = validateObjectIdParam;
