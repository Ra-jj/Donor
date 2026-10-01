const { z } = require('zod');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// The two sign-up checkboxes, each its own separate agreement. Only the boolean true passes: a
// missing value, false, the string "true" or 1 is refused, so consent is always an explicit tick.
const privacyConsentFields = {
  acceptPrivacy: z.literal(true, { error: 'Agree to the Privacy Notice to continue' }),
  confirmAdult: z.literal(true, { error: 'Confirm you are 18 or older to continue' }),
};

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters long'),
  email: z.string().email('Invalid email format').regex(/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/, 'Please enter a valid email address (e.g. name@domain.com)'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  // Zod 4 takes a custom message through `error`; the Zod 3 `errorMap` param is silently ignored
  bloodGroup: z.enum(BLOOD_GROUPS, {
    error: 'Invalid blood group',
  }),
  location: z
    .array(z.number())
    .length(2, 'Location must be an array of exactly 2 numbers [longitude, latitude]')
    .refine((val) => val[0] >= -180 && val[0] <= 180, {
      message: 'Invalid longitude',
    })
    .refine((val) => val[1] >= -90 && val[1] <= 90, {
      message: 'Invalid latitude',
    }),
  ...privacyConsentFields,
});

// POST /api/users/privacy-consent: the same two agreements, from a signed-in user who has not yet
// agreed to the current notice
const privacyConsentSchema = z.object(privacyConsentFields);

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

// DELETE /api/users/me: the current password confirms that the account owner is asking
const deleteAccountSchema = z.object({
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required'),
});

module.exports = {
  registerSchema,
  loginSchema,
  deleteAccountSchema,
  privacyConsentSchema,
};
