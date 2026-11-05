// A request the server closed once several different users had reported it while it was open
// (closeRequestIfReported in server/controllers/request.controller.js): 'cancelled' with closedReason
// 'reported'. Unlike an expired one, it has no "Post again". Nothing here says who reported it, and
// the server never sends that.
export const isReportedRequest = (request) => request?.status === 'cancelled' && request.closedReason === 'reported';

export const REPORTED_NOTE = 'Closed after reports from other users.';

export const describeReportedRequest = (hospitalName) =>
  `Your request ${hospitalName ? `at ${hospitalName} ` : ''}was closed after reports from other users.`;
