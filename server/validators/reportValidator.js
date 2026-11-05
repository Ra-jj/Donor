const { z } = require('zod');

// The client offers the same reasons and limit (client/src/components/ReportBlockDialog.jsx)
const REPORT_REASONS = ['fake', 'abusive', 'spam', 'other'];
const MAX_REPORT_NOTE_LENGTH = 300;

// Zod 4 takes a custom message through `error`, as in requestValidator.js
const reportFields = {
  reason: z.enum(REPORT_REASONS, {
    error: 'Reason must be fake, abusive, spam or other',
  }),
  // Trimmed first, so the limit counts the note itself and a note of only spaces is stored as ''
  note: z
    .string({ error: 'Note must be text' })
    .trim()
    .max(MAX_REPORT_NOTE_LENGTH, `Note cannot be longer than ${MAX_REPORT_NOTE_LENGTH} characters`)
    .optional()
    .default(''),
};

const reportRequestSchema = z.object(reportFields);

const reportUserSchema = z.object({
  ...reportFields,
  // The dialog's "Also block them" box. Never assumed: a report blocks only when the body says so.
  alsoBlock: z.boolean({ error: 'alsoBlock must be true or false' }).optional().default(false),
});

module.exports = {
  REPORT_REASONS,
  MAX_REPORT_NOTE_LENGTH,
  reportRequestSchema,
  reportUserSchema,
};
