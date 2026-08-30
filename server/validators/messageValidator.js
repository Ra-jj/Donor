const { z } = require('zod');

const sendMessageSchema = z.object({
  text: z.string()
    .min(1, 'Message cannot be empty')
    .max(1000, 'Message cannot exceed 1000 characters'),
});

module.exports = {
  sendMessageSchema,
};
