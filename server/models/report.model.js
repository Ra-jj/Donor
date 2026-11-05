const mongoose = require('mongoose');

const { REPORT_REASONS, MAX_REPORT_NOTE_LENGTH } = require('../validators/reportValidator');

// A report from one user (controllers/report.controller.js). Never sent to anyone, the reporter
// included: only the app's owner reads reports, in the database. The requester of a request that
// reports closed sees only its closedReason, never who reported it.
//
// - kind 'request': a request someone reported. reportedUserId is its requester.
// - kind 'user': the other person on a request the two were matched on (requester and donor).
//   requestId is that request, kept for context.
//
// Deleted when the reporter or the reported user deletes their account (deleteAccount in
// user.controller.js).
const reportSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['request', 'user'],
      required: true,
    },
    reporterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reportedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Request',
      required: true,
    },
    reason: {
      type: String,
      enum: REPORT_REASONS,
      required: true,
    },
    note: {
      type: String,
      default: '',
      trim: true,
      maxlength: MAX_REPORT_NOTE_LENGTH,
    },
  },
  { timestamps: true }
);

// One report per reporter per request, even when two are sent at once (E11000). requestId first,
// so the same index counts a request's reports for closeRequestIfReported (request.controller.js).
reportSchema.index(
  { requestId: 1, reporterId: 1 },
  { unique: true, partialFilterExpression: { kind: 'request' }, name: 'one_report_per_request' }
);

// One report per reporter per reported user, whichever request they were matched on
reportSchema.index(
  { reportedUserId: 1, reporterId: 1 },
  { unique: true, partialFilterExpression: { kind: 'user' }, name: 'one_report_per_user' }
);

// Account deletion removes every report a user made, and every report about them (both kinds)
reportSchema.index({ reporterId: 1 });
reportSchema.index({ reportedUserId: 1 });

module.exports = mongoose.model('Report', reportSchema);
