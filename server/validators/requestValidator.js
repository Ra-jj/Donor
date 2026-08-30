const { z } = require('zod');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const URGENCIES = ['low', 'medium', 'high'];

const createRequestSchema = z.object({
  bloodGroup: z.enum(BLOOD_GROUPS, {
    errorMap: () => ({ message: 'Invalid blood group' }),
  }),
  unitsNeeded: z
    .number({ invalid_type_error: 'Units needed must be a number' })
    .int('Units needed must be a whole number')
    .min(1, 'At least 1 unit is required')
    .max(20, 'Maximum 20 units can be requested at once'),
  hospitalName: z.string().min(2, 'Hospital name must be at least 2 characters long'),
  hospitalLocation: z
    .array(z.number())
    .length(2, 'Location must be an array of exactly 2 numbers [longitude, latitude]')
    .refine((val) => val[0] >= -180 && val[0] <= 180, {
      message: 'Invalid longitude',
    })
    .refine((val) => val[1] >= -90 && val[1] <= 90, {
      message: 'Invalid latitude',
    }),
  urgency: z.enum(URGENCIES, {
    errorMap: () => ({ message: 'Urgency must be low, medium, or high' }),
  }).optional().default('medium'),
});

module.exports = {
  createRequestSchema,
};
