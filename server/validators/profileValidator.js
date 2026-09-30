const { z } = require('zod');
const { getTodayInIndiaDateString } = require('../utils/donationGap');

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EARLIEST_DONATION_DATE = '1900-01-01';

// Dates roll impossible days over (2026-02-30 becomes 2 March), so read the parts back.
// setUTCFullYear, unlike Date.UTC, does not turn years 0-99 into 1900-1999.
const isRealCalendarDate = (dateOnly) => {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

// The value of an <input type="date">: a calendar date with no time or zone, which for this
// India-only app is a date in IST. Stored as 00:00 UTC of that date (see lastOutsideDonationDate
// in user.model.js). One message per bad value: the validate middleware keeps one per field.
// Zero-padded YYYY-MM-DD strings sort as dates, so plain string comparison is enough.
const lastOutsideDonationDateSchema = z
  .string({ error: 'Last outside donation date must be a YYYY-MM-DD date or null' })
  .superRefine((dateOnly, ctx) => {
    let problem = null;
    if (!DATE_ONLY_PATTERN.test(dateOnly)) {
      problem = 'Last outside donation date must be a YYYY-MM-DD date';
    } else if (!isRealCalendarDate(dateOnly)) {
      problem = 'Last outside donation date is not a real calendar date';
    } else if (dateOnly < EARLIEST_DONATION_DATE) {
      problem = 'Last outside donation date cannot be before 1900';
    } else if (dateOnly > getTodayInIndiaDateString()) {
      // "Today" is today in India, so a donor in IST can enter today's date just after midnight
      problem = 'Last outside donation date cannot be in the future';
    }
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  })
  .transform((dateOnly) => new Date(`${dateOnly}T00:00:00.000Z`))
  // null clears the date
  .nullable();

const updateProfileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').optional(),
  bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional(),
  location: z.array(z.number()).length(2).optional(),
  isAvailable: z.boolean().optional(),
  lastOutsideDonationDate: lastOutsideDonationDateSchema.optional(),
});

module.exports = {
  updateProfileSchema,
};
