const { z } = require('zod');

/**
 * Express middleware factory to validate req.body against a Zod schema.
 * Formats errors into a clean, frontend-friendly structure.
 */
const validate = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Map Zod errors to a flat object: { fieldName: "Error message" }
      const formattedErrors = {};
      error.issues.forEach((issue) => {
        const fieldName = issue.path[0];
        if (fieldName) {
          formattedErrors[fieldName] = issue.message;
        }
      });

      return res.status(400).json({
        message: 'Validation failed',
        errors: formattedErrors,
      });
    }
    next(error);
  }
};

module.exports = validate;
