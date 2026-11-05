const Report = require('../models/report.model');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const { describeRequestRole, closeRequestIfReported } = require('./request.controller');
const { blockUser, isBlockedOutcome, announceAfterBlock, LIMIT_REACHED_MESSAGE } = require('./block.controller');

// Writes a report. A repeat (one_report_per_request or one_report_per_user, E11000) is not an
// error: the reporter has said it already, so it is answered 200 and the first report stays as it
// was. Returns the new report, or null for a repeat.
const createReportOrFindRepeat = async (fields) => {
  try {
    return await Report.create(fields);
  } catch (error) {
    if (error.code === 11000) return null;
    throw error;
  }
};

// protectRoute found the reporter, and the request named the reported user, but either one's
// account deletion (deleteAccount in user.controller.js) can commit before the report is written,
// and after its own clean-up has run. Checked after the write, as in declineRequest: the report is
// removed again, so none outlives either account. Returns which of the two is gone, or null.
const findGoneUser = async (reporterId, reportedUserId) => {
  const [reporterExists, reportedUserExists] = await Promise.all([
    User.exists({ _id: reporterId }),
    User.exists({ _id: reportedUserId }),
  ]);
  if (!reporterExists) return 'reporter';
  if (!reportedUserExists) return 'reported';
  return null;
};

/**
 * POST /api/requests/:id/report: a donor who can see a request (in their incoming list, or as its
 * matched donor) reports it. The requester cannot report their own. Stored with the reporter, the
 * request, its requester, the reason and the note, and never shown to anyone in the app.
 *
 * The request is added to the reporter's declinedBy, so it leaves their incoming list as after a
 * decline. A pending request reported by REPORTS_TO_CLOSE_REQUEST different users is closed
 * (closeRequestIfReported). Any other status can still be reported, and is only stored.
 */
exports.reportRequest = async (req, res) => {
  try {
    const reporter = req.user;
    // Already checked and trimmed by reportRequestSchema
    const { reason, note } = req.body;

    const request = await Request.findById(req.params.id).select('requesterId matchedDonorId bloodGroup');
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }
    const role = await describeRequestRole(request, reporter);
    if (role === 'requester') {
      return res.status(403).json({ message: 'You cannot report your own request' });
    }
    if (!role) {
      return res.status(403).json({ message: 'You can only report a request you can see' });
    }
    if (!request.requesterId) {
      // A fulfilled request whose requester deleted their account: there is no one to report
      return res.status(409).json({ message: 'The requester has deleted their account' });
    }

    const report = await createReportOrFindRepeat({
      kind: 'request',
      reporterId: reporter._id,
      reportedUserId: request.requesterId,
      requestId: request._id,
      reason,
      note,
    });
    // Hidden from the reporter, whatever its status: one that goes back to pending later stays
    // hidden too. $addToSet, so a repeat adds nothing.
    await Request.updateOne({ _id: request._id }, { $addToSet: { declinedBy: reporter._id } });

    if (report) {
      const goneUser = await findGoneUser(reporter._id, request.requesterId);
      if (goneUser) {
        await Report.deleteOne({ _id: report._id });
        console.warn(`reportRequest: report ${report._id} was removed again: the ${goneUser} no longer exists`);
        if (goneUser === 'reporter') {
          await Request.updateOne({ _id: request._id }, { $pull: { declinedBy: reporter._id } });
          return res.status(401).json({ message: 'Unauthorized - User not found' });
        }
        // The requester's deletion removed the request as well, unless it was fulfilled
        return res.status(404).json({ message: 'Request not found' });
      }
    }

    // A repeat counts again too, so a close that failed after an earlier report is tried again
    await closeRequestIfReported(request._id);

    // Nothing about the other reports, or about whether this one closed the request
    return res.status(report ? 201 : 200).json({
      message: report ? 'Thank you. Your report has been sent.' : 'You have already reported this request',
    });
  } catch (error) {
    console.error('Error in reportRequest:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

/**
 * POST /api/requests/:id/report-user: the requester reports the request's matched donor, or the
 * matched donor reports the requester (from their chat). Only stored: nothing happens to the
 * reported user, since reports are not reviewed in the app and a few accounts could otherwise act
 * against anyone. alsoBlock blocks them too (blockUser), which ends the match.
 */
exports.reportUser = async (req, res) => {
  try {
    const reporter = req.user;
    // Already checked and trimmed by reportUserSchema
    const { reason, note, alsoBlock } = req.body;

    const request = await Request.findById(req.params.id).select('requesterId matchedDonorId bloodGroup');
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }
    const role = await describeRequestRole(request, reporter);
    if (role !== 'requester' && role !== 'donor') {
      return res.status(403).json({ message: 'You can only report the person you were matched with on this request' });
    }
    const reportedUserId = role === 'requester' ? request.matchedDonorId : request.requesterId;
    if (!reportedUserId) {
      // 409 like the other answers about a request that changed since the page loaded
      return res.status(409).json({
        message: role === 'requester' ? 'This request has no donor to report' : 'The requester has deleted their account',
      });
    }

    const report = await createReportOrFindRepeat({
      kind: 'user',
      reporterId: reporter._id,
      reportedUserId,
      requestId: request._id,
      reason,
      note,
    });
    if (report) {
      const goneUser = await findGoneUser(reporter._id, reportedUserId);
      if (goneUser) {
        await Report.deleteOne({ _id: report._id });
        console.warn(`reportUser: report ${report._id} was removed again: the ${goneUser} no longer exists`);
        return goneUser === 'reporter'
          ? res.status(401).json({ message: 'Unauthorized - User not found' })
          : res.status(409).json({ message: 'This person has deleted their account' });
      }
    }

    const { outcome, reopenedRequests } = alsoBlock
      ? await blockUser(reporter, reportedUserId)
      : { outcome: null, reopenedRequests: [] };
    // One of the two was deleted in the moment between the check above and the block's own check:
    // the report goes too, as it would have above
    if (outcome === 'blocker_gone' || outcome === 'blocked_gone') {
      if (report) await Report.deleteOne({ _id: report._id });
      return outcome === 'blocker_gone'
        ? res.status(401).json({ message: 'Unauthorized - User not found' })
        : res.status(409).json({ message: 'This person has deleted their account' });
    }
    const isBlocked = isBlockedOutcome(outcome);

    let message = report ? 'Thank you. Your report has been sent.' : 'You have already reported this person.';
    if (isBlocked) message += ' They are blocked.';
    if (outcome === 'limit') message += ` They were not blocked: ${LIMIT_REACHED_MESSAGE}`;

    res.status(report ? 201 : 200).json({ message, blocked: isBlocked, endedMatch: reopenedRequests.length > 0 });
    announceAfterBlock(reopenedRequests);
  } catch (error) {
    console.error('Error in reportUser:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
