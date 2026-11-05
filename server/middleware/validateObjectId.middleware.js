const mongoose = require('mongoose');

/**
 * Express middleware factory: rejects a malformed ObjectId in req.params[paramName]
 * with 400 before any DB call, instead of letting Mongoose throw a CastError (500).
 *
 * label names the id in that message ("Invalid block id"); most routes take a request id.
 *
 * Mount it AFTER protectRoute so an anonymous caller still gets 401, whatever the id.
 * (router.param would run before protectRoute, so it is deliberately not used here.)
 */
const validateObjectIdParam = (paramName, label = 'request') => (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params[paramName])) {
    return res.status(400).json({ message: `Invalid ${label} id` });
  }
  next();
};

module.exports = validateObjectIdParam;
