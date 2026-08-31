const { z } = require('zod');

const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').optional(),
  bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
  location: z.array(z.number()).length(2).optional(),
  isAvailable: z.boolean().optional(),
});

module.exports = {
  updateProfileSchema,
};
