const { z } = require('zod');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters long'),
  email: z.string().email('Invalid email format').regex(/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/, 'Please enter a valid email address (e.g. name@domain.com)'),
  password: z.string().min(6, 'Password must be at least 6 characters long'),
  bloodGroup: z.enum(BLOOD_GROUPS, {
    errorMap: () => ({ message: 'Invalid blood group' }),
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
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

module.exports = {
  registerSchema,
  loginSchema,
};
