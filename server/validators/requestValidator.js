const { z } = require('zod');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const URGENCIES = ['low', 'medium', 'high'];
// 'fulfilled' is deliberately absent: fulfilment goes only through PATCH /:id/fulfill,
// which checks that the caller is the requester.
const STATUS_UPDATES = ['accepted', 'declined', 'cancelled'];
// Donors see the hospital name on their cards, in push alerts and in shared messages. The New
// Request form's name field allows the same number (client/src/lib/hospitalName.js).
const MAX_HOSPITAL_NAME_LENGTH = 150;

// Zod 4 takes a custom message through `error`. The Zod 3 params `errorMap` and
// `invalid_type_error` are silently ignored, so they never produced these messages.
const createRequestSchema = z.object({
  bloodGroup: z.enum(BLOOD_GROUPS, {
    error: 'Invalid blood group',
  }),
  unitsNeeded: z
    .number({ error: 'Units needed must be a number' })
    .int('Units needed must be a whole number')
    .min(1, 'At least 1 unit is required')
    .max(20, 'Maximum 20 units can be requested at once'),
  // Trimmed first, so the limits count the name itself, and a name of only spaces is refused here
  // rather than passing this check and then failing the model's required check (a 500)
  hospitalName: z
    .string()
    .trim()
    .min(2, 'Hospital name must be at least 2 characters long')
    .max(MAX_HOSPITAL_NAME_LENGTH, `Hospital name cannot be longer than ${MAX_HOSPITAL_NAME_LENGTH} characters`),
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
    error: 'Urgency must be low, medium, or high',
  }).optional().default('medium'),
});

const rateRequestSchema = z.object({
  rating: z
    .number({ error: 'Rating must be a number' })
    .int('Rating must be a whole number')
    .min(1, 'Rating must be at least 1')
    .max(5, 'Rating cannot exceed 5'),
  ratingNote: z.string().max(500, 'Note cannot exceed 500 characters').optional().default(''),
});

const updateRequestStatusSchema = z.object({
  // Zod 4 uses `error` for a custom message; the Zod 3 `errorMap` param is silently ignored
  status: z.enum(STATUS_UPDATES, {
    error: 'Status must be accepted, declined, or cancelled',
  }),
});

module.exports = {
  MAX_HOSPITAL_NAME_LENGTH,
  createRequestSchema,
  rateRequestSchema,
  updateRequestStatusSchema,
};
