const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Request = require('../models/request.model');
const User = require('../models/user.model');
const Message = require('../models/message.model');
const { io } = require('../lib/socket');
const { AUTH_COOKIE_NAME, getAuthCookieOptions } = require('../utils/authCookie');
const { withDonationEligibility } = require('../utils/donationGap');
const { buildPrivacyConsentUpdate, privacyConsentMissingFilter } = require('../utils/privacyConsent');
const { notifyNearbyDonors } = require('./request.controller');

exports.getStats = async (req, res) => {
  try {
    const userId = req.user._id;

    // Donations this user completed as a donor (matched + fulfilled)
    const donorStats = await Request.aggregate([
      { $match: { matchedDonorId: userId, status: 'fulfilled' } },
      {
        $group: {
          _id: null,
          totalFulfilled: { $sum: 1 },
          avgRating: { $avg: '$rating' },
          totalRated: {
            $sum: { $cond: [{ $ne: ['$rating', null] }, 1, 0] },
          },
        },
      },
    ]);

    // Requests this user created as a requester
    const requesterStats = await Request.aggregate([
      { $match: { requesterId: userId } },
      {
        $group: {
          _id: null,
          totalCreated: { $sum: 1 },
          totalFulfilled: {
            $sum: { $cond: [{ $eq: ['$status', 'fulfilled'] }, 1, 0] },
          },
        },
      },
    ]);

    res.status(200).json({
      donor: {
        livesSaved: donorStats[0]?.totalFulfilled || 0,
        avgRating: donorStats[0]?.avgRating
          ? Math.round(donorStats[0].avgRating * 10) / 10
          : null,
        totalRated: donorStats[0]?.totalRated || 0,
      },
      requester: {
        totalCreated: requesterStats[0]?.totalCreated || 0,
        totalFulfilled: requesterStats[0]?.totalFulfilled || 0,
      },
    });
  } catch (error) {
    console.error('Error in getStats:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user._id;
    const { name, bloodGroup, location, isAvailable, lastOutsideDonationDate } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (bloodGroup !== undefined) updates.bloodGroup = bloodGroup;
    if (isAvailable !== undefined) updates.isAvailable = isAvailable;
    // Already a Date at 00:00 UTC of the chosen day (profileValidator), or null to clear it
    if (lastOutsideDonationDate !== undefined) updates.lastOutsideDonationDate = lastOutsideDonationDate;
    if (location !== undefined) {
      updates.location = {
        type: 'Point',
        coordinates: location,
      };
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updates, {
      returnDocument: 'after',
      select: '-password',
    });

    // The outside donation date can change when the donor may donate again, so send it back fresh
    res.status(200).json({ user: updatedUser ? await withDonationEligibility(updatedUser) : null });
  } catch (error) {
    console.error('Error in updateProfile:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

// POST /api/users/privacy-consent. privacyConsentSchema has already required acceptPrivacy and
// confirmAdult to be true. Records the current notice version with the server's time, so a user
// who signed up before consent was recorded, or agreed to an older notice, can keep using the app.
exports.recordPrivacyConsent = async (req, res) => {
  try {
    const userId = req.user._id;

    // Written only while the current version is still missing. A repeat (a double click, a second
    // tab) changes nothing, so acceptedAt stays the moment they first agreed to this version and
    // the consent history gets no second entry for it.
    await User.updateOne(
      { _id: userId, ...privacyConsentMissingFilter() },
      buildPrivacyConsentUpdate(),
      { runValidators: true }
    );

    const user = await User.findById(userId).select('-password');
    if (!user) {
      // The account was deleted since protectRoute read it
      return res.status(401).json({ message: 'Unauthorized - User not found' });
    }

    res.status(200).json({ user: await withDonationEligibility(user) });
  } catch (error) {
    console.error('Error in recordPrivacyConsent:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.getHistory = async (req, res) => {
  try {
    const userId = req.user._id;

    // Fetch past requests made by the user
    const pastRequests = await Request.find({ requesterId: userId })
      .populate('matchedDonorId', 'name')
      .sort({ createdAt: -1 });

    // Fetch past donations (fulfilled requests where this user was the matched donor)
    const pastDonations = await Request.find({
      matchedDonorId: userId,
      status: 'fulfilled',
    }).populate('requesterId', 'name')
      .sort({ fulfilledAt: -1 });

    res.status(200).json({ pastRequests, pastDonations });
  } catch (error) {
    console.error('Error in getHistory:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

// Thrown inside the deletion transaction when the user document is already gone, i.e. another
// deletion of the same account (from a second tab) committed first. Aborts this attempt.
class AccountAlreadyDeletedError extends Error {}

/**
 * Erases everything of one user except the user document itself, and returns who must be told
 * about it afterwards.
 *
 * - Requests they created: fulfilled ones are kept with requesterId null and the rating note they
 *   wrote cleared, so the donor keeps the donation, its rating and their donation gap. All other
 *   statuses are deleted, with their messages.
 * - Requests they were the donor on: an accepted one goes back to pending for its requester.
 *   Fulfilled and cancelled ones keep everything except matchedDonorId, and a fulfilled one also
 *   loses its rating note: the requester wrote it to and about this donor, so it is their data too.
 * - Their id is pulled from every declinedBy, and every message they sent or received is deleted.
 *
 * Runs inside the deletion transaction (with its session), and once more after the commit
 * without one (see deleteAccount).
 * @param {import('mongoose').Types.ObjectId} userId
 * @param {import('mongoose').ClientSession} [session]
 */
const eraseUserData = async (userId, session) => {
  const createdRequests = await Request.find({ requesterId: userId })
    .select('_id status matchedDonorId')
    .session(session)
    .lean();
  const donatedRequests = await Request.find({ matchedDonorId: userId })
    .select('_id status requesterId')
    .session(session)
    .lean();
  const removedRequests = createdRequests.filter((request) => request.status !== 'fulfilled');

  // a. Requests they created
  await Request.deleteMany({ requesterId: userId, status: { $ne: 'fulfilled' } }, { session });
  await Request.updateMany(
    { requesterId: userId, status: 'fulfilled' },
    { $set: { requesterId: null, ratingNote: '' } },
    { session }
  );

  // b. Requests they were the donor on. A cancelled one only loses the id: nothing reads the
  // donor of a cancelled request, and keeping it would leave this user's id behind.
  await Request.updateMany(
    { matchedDonorId: userId, status: 'accepted' },
    { $set: { status: 'pending', matchedDonorId: null } },
    { session }
  );
  await Request.updateMany(
    { matchedDonorId: userId, status: 'fulfilled' },
    { $set: { matchedDonorId: null, ratingNote: '' } },
    { session }
  );
  await Request.updateMany({ matchedDonorId: userId }, { $set: { matchedDonorId: null } }, { session });

  // c. Their declines
  await Request.updateMany({ declinedBy: userId }, { $pull: { declinedBy: userId } }, { session });

  // d. Their messages, and any left on a request deleted above
  await Message.deleteMany(
    {
      $or: [
        { senderId: userId },
        { receiverId: userId },
        { requestId: { $in: removedRequests.map((request) => request._id) } },
      ],
    },
    { session }
  );

  return {
    // The donor of an accepted request that was just deleted
    donorsOfCancelledRequests: removedRequests
      .filter((request) => request.status === 'accepted' && request.matchedDonorId)
      .map((request) => ({ requestId: request._id, donorId: request.matchedDonorId })),
    // The requester of a request this user had accepted, which is pending again
    requestersOfReopenedRequests: donatedRequests
      .filter((request) => request.status === 'accepted' && request.requesterId)
      .map((request) => ({ requestId: request._id, requesterId: request.requesterId })),
  };
};

/**
 * Erases one user in a single transaction: eraseUserData, then (e) the user document itself,
 * with its push subscription and profile picture.
 *
 * Reads and writes inside one transaction share one snapshot, and a request that an accept or
 * fulfil changes meanwhile aborts the attempt with a write conflict. The driver then re-runs this
 * whole callback, so the notification lists are rebuilt from each attempt's own reads.
 * @param {import('mongoose').Types.ObjectId} userId
 */
const eraseUserInTransaction = (userId) =>
  mongoose.connection.transaction(async (session) => {
    const notifications = await eraseUserData(userId, session);

    // e. The user
    const { deletedCount } = await User.deleteOne({ _id: userId }, { session });
    if (deletedCount !== 1) {
      throw new AccountAlreadyDeletedError('user document already deleted');
    }

    return notifications;
  });

const NO_NOTIFICATIONS = { donorsOfCancelledRequests: [], requestersOfReopenedRequests: [] };

// A request, accept, decline or message this user wrote after the transaction's reads is not in
// its snapshot, so it survives the commit. createRequest, acceptRequest, declineRequest and
// sendMessage each check that their user still exists right after writing, and undo the write if
// not; but a check that ran before the commit still found the user. Every read from here on sees
// the commit, so a second pass over the same steps removes whatever those writes left. No
// session: the account is already gone, and each step stands on its own. A failure is logged,
// never a 500.
const sweepAfterCommit = async (userId) => {
  try {
    return await eraseUserData(userId);
  } catch (error) {
    console.error(`deleteAccount: the clean-up after erasing user ${userId} failed:`, error.message);
    return NO_NOTIFICATIONS;
  }
};

// The clean-up can find a request the transaction already handled: the transaction put it back to
// pending, and an accept by this user that was already on its way then took it again. Each
// request is still announced once.
const appendUnseenRequests = (first, second) => {
  const seenRequestIds = new Set(first.map(({ requestId }) => String(requestId)));
  return [...first, ...second.filter(({ requestId }) => !seenRequestIds.has(String(requestId)))];
};

const mergeNotifications = (first, second) => ({
  donorsOfCancelledRequests: appendUnseenRequests(first.donorsOfCancelledRequests, second.donorsOfCancelledRequests),
  requestersOfReopenedRequests: appendUnseenRequests(first.requestersOfReopenedRequests, second.requestersOfReopenedRequests),
});

// Only after the commit. The account is already gone, so a failed emit is logged and the rest
// still go out; it never turns the deletion into a 500. The payloads carry a reason and no name:
// the account was deleted, so its name is not passed on.
const notifyAfterAccountDeletion = (deletedUser, { donorsOfCancelledRequests, requestersOfReopenedRequests }) => {
  donorsOfCancelledRequests.forEach(({ requestId, donorId }) => {
    try {
      // The event a cancel by the requester sends (cancelRequest)
      io.to(String(donorId)).emit('requestStatusUpdate', {
        requestId,
        status: 'cancelled',
        reason: 'account_deleted',
      });
    } catch (error) {
      console.error(`deleteAccount: failed to notify donor ${donorId} of cancelled request ${requestId}:`, error.message);
    }
  });

  requestersOfReopenedRequests.forEach(({ requestId, requesterId }) => {
    try {
      // The event an accept sends (acceptRequest), with the new status
      io.to(String(requesterId)).emit('requestStatusUpdate', {
        requestId,
        status: 'pending',
        reason: 'account_deleted',
      });
    } catch (error) {
      console.error(`deleteAccount: failed to notify requester ${requesterId} of reopened request ${requestId}:`, error.message);
    }
  });

  try {
    // Every tab and device of this user leaves its room at once. socket.io-client does not retry a
    // server-side disconnect and closes the connection itself, and a new connection with the old
    // cookie is refused (no user exists for its userId). Not disconnectSockets(true): closing the
    // transport from this side kept the Jest process alive ~30 s after the socket test.
    io.in(String(deletedUser._id)).disconnectSockets();
  } catch (error) {
    console.error(`deleteAccount: failed to disconnect the sockets of user ${deletedUser._id}:`, error.message);
  }
};

// A request this user had accepted is open again. Nearby donors were alerted only when it was
// created, and donors who were busy or resting then were left out, so it is announced again the
// same way. Each request is re-read first: another donor may have accepted it since, or its
// requester cancelled it. Runs after the response, like createRequest's alerts, and only logs.
const announceReopenedRequests = async (requestersOfReopenedRequests) => {
  for (const { requestId } of requestersOfReopenedRequests) {
    try {
      const reopenedRequest = await Request.findOne({ _id: requestId, status: 'pending' });
      const requester = reopenedRequest
        ? await User.findById(reopenedRequest.requesterId).select('name').lean()
        : null;
      if (requester) {
        await notifyNearbyDonors(reopenedRequest, requester.name);
      }
    } catch (error) {
      console.error(`deleteAccount: failed to alert donors near reopened request ${requestId}:`, error.message);
    }
  }
};

exports.deleteAccount = async (req, res) => {
  try {
    const deletedUser = req.user;
    const { password } = req.body;

    // protectRoute leaves the password hash out of req.user
    const storedUser = await User.findById(deletedUser._id).select('password');
    if (!storedUser) {
      // Deleted since protectRoute read it (another tab won the race): the cookie is dead either
      // way, so remove it as the other answers do
      res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions());
      return res.status(401).json({ message: 'Unauthorized - User not found' });
    }

    const isPasswordCorrect = await bcrypt.compare(password, storedUser.password);
    if (!isPasswordCorrect) {
      // 403, not 401: the session itself is valid, and 401 elsewhere means "signed out"
      return res.status(403).json({ message: 'Incorrect password. Your account was not deleted.' });
    }

    let notifications;
    try {
      notifications = await eraseUserInTransaction(deletedUser._id);
    } catch (error) {
      if (error instanceof AccountAlreadyDeletedError) {
        res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions());
        return res.status(401).json({ message: 'Unauthorized - User not found' });
      }
      throw error;
    }
    notifications = mergeNotifications(notifications, await sweepAfterCommit(deletedUser._id));

    // Same attributes as the login cookie, as in logout, so the browser matches and removes it
    res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions());
    notifyAfterAccountDeletion(deletedUser, notifications);
    res.status(200).json({ message: 'Your account has been deleted' });

    // Not awaited: the 200 has been sent, and announceReopenedRequests logs its own failures.
    // The catch is only a last guard against an unhandled rejection.
    announceReopenedRequests(notifications.requestersOfReopenedRequests).catch((error) =>
      console.error('deleteAccount: failed to alert donors near reopened requests:', error.message)
    );
  } catch (error) {
    console.error('Error in deleteAccount:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
