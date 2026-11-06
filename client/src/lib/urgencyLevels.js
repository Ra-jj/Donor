// The urgency choices of the request form (pages/CreateRequestPage.jsx). label is the full wording:
// the text a requester shares (lib/shareRequest.js) and a shared request's page use it, so both say
// what the form offered. selectLabel says the same in fewer words, for the form's select, which
// shows its choice on one line: at 320 px the full labels were cut off ("Medium (Within 24 hour").
// The values are the ones the server accepts (server/models/request.model.js): low, medium, high.
export const URGENCY_LEVELS = [
  { value: 'low', label: 'Low (Within 48 hours)', selectLabel: 'Low (2 days)' },
  { value: 'medium', label: 'Medium (Within 24 hours)', selectLabel: 'Medium (1 day)' },
  { value: 'high', label: 'High (Immediate/Emergency)', selectLabel: 'High (right now)' }
];
