const Block = require('../models/block.model');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const { io } = require('../lib/socket');
const { MAX_BLOCKS_PER_USER } = require('../utils/blocks');
const { hasExpired } = require('../utils/requestExpiry');
const { describeRequestRole, reopenAcceptedRequest } = require('./request.controller');
const { announceReopenedRequests } = require('./user.controller');

// What each side of a match that a block ended is told. The blocked person never hears it was a
// block: a donor whose requester blocked them hears only that the request is no longer theirs
// (reason 'match_ended'), and a requester whose donor blocked them hears that the donor can no
// longer help, as if they had withdrawn (reason 'donor_withdrew'). The blocker's own other tabs and
// devices get reason 'blocked', and apply it without a popup. Logged, never thrown: the match has
// already ended.
const notifyMatchEnded = (reopenedRequest, donorId, isBlockerTheRequester) => {
  try {
    // The event a cancel sends the donor (cancelRequest), so their card goes and they are free
    io.to(String(donorId)).emit('requestStatusUpdate', {
      requestId: reopenedRequest._id,
      status: 'cancelled',
      reason: isBlockerTheRequester ? 'match_ended' : 'blocked',
    });
    // Already past its open hours: announceReopenedRequests closes it, which sends its requester the
    // expiry event, and "open to donors again" right before that would contradict it (as in
    // deleteAccount's notifyAfterAccountDeletion)
    if (!hasExpired(reopenedRequest)) {
      io.to(String(reopenedRequest.requesterId)).emit('requestStatusUpdate', {
        requestId: reopenedRequest._id,
        status: 'pending',
        reason: isBlockerTheRequester ? 'blocked' : 'donor_withdrew',
      });
    }
  } catch (error) {
    console.error(`Block: failed to tell both sides that the match on request ${reopenedRequest._id} ended:`, error.message);
  }
};

/**
 * Ends every accepted match between two users after one blocked the other: each request goes back
 * to pending, with its donor added to declinedBy so it never reaches them again (the undo-accept
 * write, reopenAcceptedRequest), and both sides are told. Its chat ends with it: getMessages and
 * sendMessage answer only while the request is accepted, and only between its requester and its
 * current donor. A donor holds at most one accepted request (one_active_donation_per_donor), so
 * there is at most one match each way.
 *
 * Runs after the block is written, so an accept that missed the block before its write is found
 * here; one that lands after this read sees the block in its own check after the write
 * (acceptRequest). A request fulfilled or cancelled meanwhile no longer matches the write, and is
 * left as it is.
 * @param {import('mongoose').Document} blocker - req.user
 * @param {import('mongoose').Types.ObjectId} blockedUserId
 * @returns {Promise<{ requestId: import('mongoose').Types.ObjectId }[]>} the requests reopened,
 * for announceReopenedRequests
 */
const endMatchesAfterBlock = async (blocker, blockedUserId) => {
  const matches = await Request.find({
    status: 'accepted',
    $or: [
      { requesterId: blocker._id, matchedDonorId: blockedUserId },
      { requesterId: blockedUserId, matchedDonorId: blocker._id },
    ],
  })
    .select('_id requesterId matchedDonorId')
    .lean();

  const reopenedRequests = [];
  for (const match of matches) {
    const reopenedRequest = await reopenAcceptedRequest(match._id, match.matchedDonorId, { asDeclined: true });
    if (!reopenedRequest) continue;
    notifyMatchEnded(reopenedRequest, match.matchedDonorId, String(match.requesterId) === String(blocker._id));
    reopenedRequests.push({ requestId: reopenedRequest._id });
  }
  return reopenedRequests;
};

/**
 * One user blocks another, and any match between them ends (endMatchesAfterBlock).
 * @param {import('mongoose').Document} blocker - req.user
 * @param {import('mongoose').Types.ObjectId} blockedUserId
 * @returns {Promise<{
 *   outcome: 'blocked' | 'already_blocked' | 'limit' | 'blocker_gone' | 'blocked_gone',
 *   reopenedRequests: { requestId: import('mongoose').Types.ObjectId }[],
 * }>}
 */
const blockUser = async (blocker, blockedUserId) => {
  let block;
  try {
    block = await Block.create({ blockerId: blocker._id, blockedId: blockedUserId });
  } catch (error) {
    // one_block_per_pair: blocked already, by a repeat or by two blocks sent at once. The match
    // clean-up runs again: it changes nothing if the first one finished, and finishes it if not.
    if (error.code !== 11000) throw error;
    return { outcome: 'already_blocked', reopenedRequests: await endMatchesAfterBlock(blocker, blockedUserId) };
  }

  // The limit, counted after the write. Each count includes this block and every block already
  // written, so a block that takes the user past the limit always sees it and removes itself, and
  // of blocks sent at once, two can never both stay past it (both may be refused; a retry then
  // works). A user can never hold more than MAX_BLOCKS_PER_USER. A count before the write would let
  // blocks sent at once all through.
  const blockCount = await Block.countDocuments({ blockerId: blocker._id });
  if (blockCount > MAX_BLOCKS_PER_USER) {
    await Block.deleteOne({ _id: block._id });
    return { outcome: 'limit', reopenedRequests: [] };
  }

  // protectRoute found the blocker, and the request named the other user, but either one's account
  // deletion (deleteAccount in user.controller.js) can commit before this write lands, and after
  // its own clean-up has run. Checked after the write, as in declineRequest, so no block outlives
  // either account.
  const [blockerExists, blockedUserExists] = await Promise.all([
    User.exists({ _id: blocker._id }),
    User.exists({ _id: blockedUserId }),
  ]);
  if (!blockerExists || !blockedUserExists) {
    await Block.deleteOne({ _id: block._id });
    console.warn(`blockUser: block ${block._id} was removed again: ${blockerExists ? 'the blocked user' : 'the blocker'} no longer exists`);
    return { outcome: blockerExists ? 'blocked_gone' : 'blocker_gone', reopenedRequests: [] };
  }

  return { outcome: 'blocked', reopenedRequests: await endMatchesAfterBlock(blocker, blockedUserId) };
};
exports.blockUser = blockUser;

// Whether a blockUser outcome left the two users blocked
const isBlockedOutcome = (outcome) => outcome === 'blocked' || outcome === 'already_blocked';
exports.isBlockedOutcome = isBlockedOutcome;

// Not awaited by the routes: the answer has been sent, and announceReopenedRequests logs its own
// failures. The catch is only a last guard against an unhandled rejection.
const announceAfterBlock = (reopenedRequests) => {
  if (reopenedRequests.length === 0) return;
  announceReopenedRequests(reopenedRequests, 'block').catch((error) =>
    console.error('block: failed to alert donors near reopened requests:', error.message)
  );
};
exports.announceAfterBlock = announceAfterBlock;

const LIMIT_REACHED_MESSAGE = `You have blocked ${MAX_BLOCKS_PER_USER} people, the most Donor allows. Unblock someone in Profile to block another.`;
exports.LIMIT_REACHED_MESSAGE = LIMIT_REACHED_MESSAGE;

/**
 * POST /api/requests/:id/block: the caller blocks the other person on one request, so the client
 * never needs (or gets) anyone's user id. The requester blocks its matched donor; its matched
 * donor, or a donor it reaches in their incoming list ("Block this requester"), blocks its
 * requester. The answer never says anything about the other person.
 */
exports.blockFromRequest = async (req, res) => {
  try {
    const blocker = req.user;
    const request = await Request.findById(req.params.id).select('requesterId matchedDonorId bloodGroup');
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    const role = await describeRequestRole(request, blocker);
    if (!role) {
      return res.status(403).json({ message: 'You can only block someone on a request you can see' });
    }
    const blockedUserId = role === 'requester' ? request.matchedDonorId : request.requesterId;
    if (!blockedUserId) {
      // 409 like the other answers about a request that changed since the page loaded
      return res.status(409).json({
        message: role === 'requester' ? 'This request has no donor to block' : 'The requester has deleted their account',
      });
    }

    const { outcome, reopenedRequests } = await blockUser(blocker, blockedUserId);
    if (outcome === 'limit') {
      return res.status(409).json({ message: LIMIT_REACHED_MESSAGE });
    }
    if (outcome === 'blocker_gone') {
      return res.status(401).json({ message: 'Unauthorized - User not found' });
    }
    if (outcome === 'blocked_gone') {
      return res.status(409).json({ message: 'This person has deleted their account' });
    }

    res.status(outcome === 'blocked' ? 201 : 200).json({
      message: outcome === 'blocked' ? 'Blocked' : 'Already blocked',
      // The dashboard reloads when a match ended, so the chat closes on this tab too
      endedMatch: reopenedRequests.length > 0,
    });
    announceAfterBlock(reopenedRequests);
  } catch (error) {
    console.error('Error in blockFromRequest:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

// The first word of a name, the most the Blocked users list shows of someone the caller met on a
// request (their name was already on it)
const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0];

/**
 * GET /api/users/blocks: the people the caller blocked, newest first, each with the block's own id
 * (for Unblock), their first name and the date. Never their user id, and never who blocked the
 * caller. At most MAX_BLOCKS_PER_USER entries.
 */
exports.getBlockedUsers = async (req, res) => {
  try {
    const blocks = await Block.find({ blockerId: req.user._id })
      .sort({ createdAt: -1, _id: -1 })
      .populate('blockedId', 'name')
      .lean();
    // A block whose blocked user is gone is about to be removed by their account deletion's clean-up
    const blockedUsers = blocks
      .filter((block) => block.blockedId)
      .map((block) => ({ _id: block._id, name: firstNameOf(block.blockedId.name), blockedAt: block.createdAt }));
    res.status(200).json({ blockedUsers });
  } catch (error) {
    console.error('Error in getBlockedUsers:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

/**
 * DELETE /api/users/blocks/:blockId: removes one of the caller's own blocks. Only the block goes:
 * a request that a block reopened keeps its donor in declinedBy, as after a decline. 404 for a block
 * that is not the caller's, so a block id says nothing to anyone else.
 */
exports.unblockUser = async (req, res) => {
  try {
    const { deletedCount } = await Block.deleteOne({ _id: req.params.blockId, blockerId: req.user._id });
    if (deletedCount === 0) {
      return res.status(404).json({ message: 'Block not found' });
    }
    res.status(200).json({ message: 'Unblocked' });
  } catch (error) {
    console.error('Error in unblockUser:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
