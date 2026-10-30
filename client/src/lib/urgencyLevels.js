// The urgency choices of the request form (pages/CreateRequestPage.jsx). The text a requester
// shares (lib/shareRequest.js) uses the same labels, so both say the same thing.
// The values are the ones the server accepts (server/models/request.model.js): low, medium, high.
export const URGENCY_LEVELS = [
  { value: 'low', label: 'Low (Within 48 hours)' },
  { value: 'medium', label: 'Medium (Within 24 hours)' },
  { value: 'high', label: 'High (Immediate/Emergency)' }
];
