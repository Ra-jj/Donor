const Request = require('../models/request.model');
const User = require('../models/user.model');
const Report = require('../models/report.model');
const { io } = require('../lib/socket');
// VAPID keys are set once there, for these alerts and the donation reminders alike
const { webpush } = require('../utils/webPush');
const {
  isCompatibleDonor,
  getCompatibleDonorGroups,
  getCompatibleRecipientGroups,
} = require('../utils/bloodCompatibility');
const {
  PIN_CANDIDATE_MARGIN_KM,
  roundCoordinatePair,
  buildDonorPins,
  angularDistanceRadians,
} = require('../utils/locationPrivacy');
const { describePushEndpointProblem } = require('../validators/pushValidator');
const {
  getDonationGapCutoff,
  inAppDonationInGapFilter,
  noOutsideDonationInGapFilter,
  findNextEligibleDonationAt,
  describeDonationGap,
} = require('../utils/donationGap');
const {
  stillOpenFilter,
  hasExpired,
  getRequestExpiresAt,
  expireStaleRequestsLogged,
  expireRequesterStaleRequests,
  expireStaleRequestsIfDue,
} = require('../utils/requestExpiry');
const { sendDonationRemindersIfDue } = require('../utils/donationReminders');
const { generateShareToken } = require('../utils/shareToken');
const { findBlockedPairUserIds, isBlockedPair } = require('../utils/blocks');

const RADIUS_KM = 15;
const EARTH_RADIUS_KM = 6378.1;

// IMPORTANT: $centerSphere takes radius in radians.
// To convert km to radians, divide distance by Earth's radius (6378.1 km).
const RADIUS_IN_RADIANS = RADIUS_KM / EARTH_RADIUS_KM;
// Wider, so the same query also returns every donor whose ROUNDED point is within RADIUS_KM
const CANDIDATE_RADIUS_IN_RADIANS = (RADIUS_KM + PIN_CANDIDATE_MARGIN_KM) / EARTH_RADIUS_KM;

/**
 * Geospatial query for the donors a pending request may reach, over the wider candidate radius.
 * Leaves out busy and resting donors, the requester, every donor who declined the request, and
 * every donor in a block with the requester, whichever of them made it.
 * @param {import('mongoose').Document} request - a saved Request document
 */
const findCandidateDonors = async (request) => {
  // Find all donors whose blood group is compatible with the requested blood group
  const compatibleDonorGroups = getCompatibleDonorGroups(request.bloodGroup);

  // Busy donors already hold an accepted request, so they are left out even when their own
  // isAvailable choice is true. one_active_donation_per_donor keeps this to one per donor.
  // Donors inside the minimum gap after a donation are left out the same way: those who
  // donated through the app here, those who reported an outside donation in the User filter.
  // Blocked pairs (utils/blocks.js) are left out of the alerts, the count and the pins alike, so
  // to a requester a donor who blocked them looks like any donor who is busy, resting or away.
  const donationGapCutoff = getDonationGapCutoff();
  const [unavailableDonorIds, blockedUserIds] = await Promise.all([
    Request.distinct('matchedDonorId', {
      $or: [{ status: 'accepted' }, inAppDonationInGapFilter(donationGapCutoff)],
    }),
    findBlockedPairUserIds(request.requesterId),
  ]);

  // One query over the wider radius; both donor lists in createRequest are filtered from it in
  // JS, so leaving busy and resting donors out here keeps them out of the notify list AND the
  // count and pins. Select only what the callers use: _id for the socket room, bloodGroup for
  // exact vs compatible, pushSubscription for the push, and location for the two distance checks.
  // declinedBy is always empty on a new request; a reopened one keeps the donors who said no.
  return User.find({
    // Exclude busy or resting donors, the requester, donors who declined, and blocked pairs
    _id: { $nin: [...unavailableDonorIds, request.requesterId, ...request.declinedBy, ...blockedUserIds] },
    bloodGroup: { $in: compatibleDonorGroups },
    isAvailable: true,
    ...noOutsideDonationInGapFilter(donationGapCutoff),
    location: {
      $geoWithin: {
        // [ [lng, lat], radiusInRadians ]. A copy: casting the query writes into this array,
        // and the document's own array would then count as modified.
        $centerSphere: [[...request.hospitalLocation.coordinates], CANDIDATE_RADIUS_IN_RADIANS],
      },
    },
  }).select('_id bloodGroup pushSubscription location');
};

// Donors to notify: EXACT home within RADIUS_KM, the rule the $centerSphere query applied
// before (same spherical model, same radius in radians)
const keepDonorsWithinExactRadius = (request, candidateDonors) =>
  candidateDonors.filter(
    (donor) =>
      angularDistanceRadians(request.hospitalLocation.coordinates, donor.location.coordinates) <= RADIUS_IN_RADIANS
  );

// The newBloodRequest payload: only the fields the donor's incoming card reads, so no
// requesterId or other user ids
const buildRequestForDonors = (request, requesterName) => {
  const savedRequest = request.toObject();
  return {
    _id: savedRequest._id,
    bloodGroup: savedRequest.bloodGroup,
    unitsNeeded: savedRequest.unitsNeeded,
    hospitalName: savedRequest.hospitalName,
    hospitalLocation: savedRequest.hospitalLocation,
    urgency: savedRequest.urgency,
    status: savedRequest.status,
    createdAt: savedRequest.createdAt,
    requesterName,
  };
};

// Real-time socket events and web push notifications to the donors near a pending request.
// A try/catch per donor: callers run this after their response has been sent (the outer catch
// would try a 500), and one failing donor must not stop the rest from being notified.
const sendNewRequestAlerts = (donorsToNotify, requestForDonors) => {
  const { bloodGroup, unitsNeeded, hospitalName, requesterName } = requestForDonors;

  donorsToNotify.forEach((donor) => {
    try {
      const isExactMatch = donor.bloodGroup === bloodGroup;
      const matchType = isExactMatch ? 'exact' : 'compatible';

      io.to(donor._id.toString()).emit('newBloodRequest', { ...requestForDonors, matchType });

      // Subscriptions stored before endpoint validation existed are re-checked before any send
      const pushEndpointProblem =
        donor.pushSubscription && describePushEndpointProblem(donor.pushSubscription.endpoint);
      if (pushEndpointProblem) {
        console.error(`Skipped web push to donor ${donor._id}: ${pushEndpointProblem}`);
        User.findByIdAndUpdate(donor._id, { pushSubscription: null })
          .exec()
          .catch((clearError) => console.error('Failed to clear push subscription:', clearError.message));
      }

      // Send Web Push Notification if the donor is subscribed
      if (donor.pushSubscription && !pushEndpointProblem) {
        const payload = JSON.stringify({
          title: '🚨 Emergency Blood Request!',
          body: `${requesterName} needs ${unitsNeeded} ${unitsNeeded === 1 ? 'unit' : 'units'} of ${bloodGroup} at ${hospitalName}. ${isExactMatch ? 'You are an exact match!' : 'You are a compatible match!'}`,
          icon: '/pwa-192x192.png',
          data: { url: '/dashboard' }
        });

        webpush.sendNotification(donor.pushSubscription, payload).catch((err) => {
          console.error(`Failed to send web push to donor ${donor._id}:`, err.message);
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired or invalid, remove it
            User.findByIdAndUpdate(donor._id, { pushSubscription: null })
              .exec()
              .catch((clearError) => console.error('Failed to clear push subscription:', clearError.message));
          }
        });
      }
    } catch (notifyError) {
      console.error(`Error notifying donor ${donor._id}:`, notifyError.message);
    }
  });
};

/**
 * Alerts every compatible, free donor within RADIUS_KM of a pending request, as createRequest
 * does for a new one. Also used when a request goes back to pending (deleteAccount in
 * user.controller.js). Rejects only if a query fails; each donor's alert is guarded on its own.
 * @param {import('mongoose').Document} request - a saved Request document
 * @param {string} requesterName
 */
const notifyNearbyDonors = async (request, requesterName) => {
  const candidateDonors = await findCandidateDonors(request);
  sendNewRequestAlerts(keepDonorsWithinExactRadius(request, candidateDonors), buildRequestForDonors(request, requesterName));
};
exports.notifyNearbyDonors = notifyNearbyDonors;

exports.createRequest = async (req, res) => {
  try {
    const { bloodGroup, unitsNeeded, hospitalName, hospitalLocation, urgency } = req.body;
    const requesterId = req.user._id;

    if (!bloodGroup || !unitsNeeded || !hospitalName || !hospitalLocation) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }

    // 1. Create and save the request
    const newRequest = new Request({
      requesterId,
      bloodGroup,
      unitsNeeded,
      hospitalName,
      hospitalLocation: {
        type: 'Point',
        coordinates: hospitalLocation, // [longitude, latitude]
      },
      urgency: urgency || 'medium',
      status: 'pending',
      // For the link the requester can share (utils/shareToken.js)
      shareToken: generateShareToken(),
    });

    await newRequest.save();

    // protectRoute found the requester, but their account deletion (deleteAccount in
    // user.controller.js) can commit before this save lands, and after its own clean-up has run.
    // Checked after the write: a check that runs before the commit still sees the requester,
    // and then that clean-up, which starts after the commit, removes the request instead. No
    // donor has heard of it yet.
    if (!(await User.exists({ _id: requesterId }))) {
      await Request.deleteOne({ _id: newRequest._id });
      console.warn(`createRequest: requester ${requesterId} no longer exists, so request ${newRequest._id} was removed again`);
      return res.status(401).json({ message: 'Unauthorized - User not found' });
    }

    // 2. Geospatial query to find matching donors
    const candidateDonors = await findCandidateDonors(newRequest);
    const donorsToNotify = keepDonorsWithinExactRadius(newRequest, candidateDonors);

    // What the requester sees depends ONLY on rounded homes. If the count used exact homes,
    // a requester could move the hospital point until a donor drops out of the count and so
    // binary-search the 15 km edge down to that donor's exact home.
    // Accepted inaccuracy: near the edge, the count and pins can differ slightly from who was
    // notified (a donor just outside may be counted, one just inside may not). The UI only
    // says "compatible donors near", so that is fine.
    const visibleDonorPoints = candidateDonors
      .map((donor) => roundCoordinatePair(donor.location.coordinates))
      .filter((point) => point && angularDistanceRadians(hospitalLocation, point) <= RADIUS_IN_RADIANS);

    // Built before the 201 so a failure here is still a 500
    const requestForDonors = buildRequestForDonors(newRequest, req.user.name);

    res.status(201).json({
      message: 'Request created and donors matched successfully',
      // Without its shareToken (the model's toJSON drops it), which is sent on its own below
      request: newRequest,
      // Any logged-in user can create a request anywhere, so only a count and ~1.1 km pins
      // go back: no donor ids, names, emails, blood groups, push data or exact coordinates.
      matchedDonorCount: visibleDonorPoints.length,
      donorPins: buildDonorPins(visibleDonorPoints),
      // The requester's own request, so its share link's token can go to them, and only to them
      shareToken: newRequest.shareToken,
    });

    // 3. Emit real-time socket events and web push notifications to matched donors.
    // Runs AFTER the response: sendNotification does synchronous encryption work per donor
    // inside the exact radius, which would otherwise be a timing signal on exact homes.
    sendNewRequestAlerts(donorsToNotify, requestForDonors);
  } catch (error) {
    console.error('Error in createRequest:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.getMyRequests = async (req, res) => {
  try {
    // A request of theirs that ran out while the server slept is closed (and announced) first,
    // so the list never shows it as still open
    await expireRequesterStaleRequests(req.user._id);
    const requests = await Request.find({ requesterId: req.user._id }).sort({ createdAt: -1 });
    res.status(200).json({ requests });
  } catch (error) {
    console.error('Error in getMyRequests:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.getIncomingRequests = async (req, res) => {
  try {
    const donor = req.user;
    const radiusInRadians = RADIUS_KM / EARTH_RADIUS_KM;
    
    // Get all recipient groups this donor is medically allowed to donate to
    const compatibleRecipientGroups = getCompatibleRecipientGroups(donor.bloodGroup);

    // Tells requesters whose requests ran out. Throttled, and not awaited: this list does not need
    // it (the filter below leaves out an expired request whether or not a sweep has marked it
    // yet), and a sweep over a backlog would hold the list up for as long as it runs. It never
    // rejects: it logs its own failures.
    expireStaleRequestsIfDue();
    // Sends the "You can donate again" reminders that are due, the same way: throttled, not awaited,
    // and never rejecting (utils/donationReminders.js)
    sendDonationRemindersIfDue();

    // No open request from anyone in a block with this donor, whichever of them made it
    const blockedUserIds = await findBlockedPairUserIds(donor._id);

    // Find pending requests nearby matching compatible blood groups, OR requests this donor has already accepted
    const rawIncomingRequests = await Request.find({
      $or: [
        {
          status: 'pending',
          ...stillOpenFilter(),
          bloodGroup: { $in: compatibleRecipientGroups },
          requesterId: { $ne: donor._id, $nin: blockedUserIds },
          declinedBy: { $ne: donor._id },
          hospitalLocation: {
            $geoWithin: {
              $centerSphere: [donor.location.coordinates, radiusInRadians],
            },
          },
        },
        {
          matchedDonorId: donor._id,
          status: { $in: ['accepted', 'fulfilled'] }
        }
      ]
    })
      // Pending requests reach nearby donors who are strangers to the requester, and the
      // client reads nothing from requesterId here, so the requester's user id is left out
      .populate('requesterId', 'name profilePic -_id')
      .sort({ createdAt: -1 });

    // Inject matchType tag before sending to client
    const incomingRequests = rawIncomingRequests.map(reqDoc => {
      const reqObj = reqDoc.toObject();
      if (reqObj.status === 'pending') {
        reqObj.matchType = (reqObj.bloodGroup === donor.bloodGroup) ? 'exact' : 'compatible';
      }
      return reqObj;
    });

    // Busy = holding an accepted request. The second $or branch above has no radius or
    // blood-group filter, so that request is always in this list when it exists.
    const hasActiveDonation = rawIncomingRequests.some(
      (reqDoc) => reqDoc.status === 'accepted' && String(reqDoc.matchedDonorId) === String(donor._id)
    );

    // A donor inside the donation gap still gets the list, like a busy donor: it shows what is
    // needed nearby and keeps their own donations (the thank-you card), and they can still
    // decline. nextEligibleDonationAt (null when they may donate) lets the dashboard disable
    // Accept and say from when; acceptRequest refuses the accept either way.
    const nextEligibleDonationAt = await findNextEligibleDonationAt(donor._id, donor.lastOutsideDonationDate);

    res.status(200).json({ incomingRequests, hasActiveDonation, nextEligibleDonationAt });
  } catch (error) {
    console.error('Error in getIncomingRequests:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

// Hospital within RADIUS_KM of the donor: the same radius rule getIncomingRequests uses
const withinDonorRadius = (donor) => ({
  $geoWithin: {
    $centerSphere: [donor.location.coordinates, RADIUS_KM / EARTH_RADIUS_KM],
  },
});

/**
 * How a user stands to a request, for reports and blocks (report.controller.js,
 * block.controller.js):
 * - 'requester': they made it;
 * - 'donor': they are its matched donor (accepted, fulfilled, or cancelled after an accept);
 * - 'viewer': a donor it reaches, by getIncomingRequests' rules: a compatible blood group and the
 *   hospital within RADIUS_KM of their saved location. Whatever its status now: the list they saw
 *   it in may be older than its last change;
 * - null: none of these, so they had no way to see it.
 * @param {import('mongoose').Document} request
 * @param {import('mongoose').Document} user - req.user
 * @returns {Promise<'requester' | 'donor' | 'viewer' | null>}
 */
const describeRequestRole = async (request, user) => {
  // String(): requesterId is null on a fulfilled request whose requester deleted their account
  if (String(request.requesterId) === String(user._id)) return 'requester';
  if (request.matchedDonorId && String(request.matchedDonorId) === String(user._id)) return 'donor';
  if (!isCompatibleDonor(user.bloodGroup, request.bloodGroup)) return null;
  const isWithinRadius = await Request.exists({ _id: request._id, hospitalLocation: withinDonorRadius(user) });
  return isWithinRadius ? 'viewer' : null;
};
exports.describeRequestRole = describeRequestRole;

// A pending request reported by this many different users, each with an account older than the
// request, is closed (closeRequestIfReported)
const REPORTS_TO_CLOSE_REQUEST = 3;
exports.REPORTS_TO_CLOSE_REQUEST = REPORTS_TO_CLOSE_REQUEST;

// Tells everyone who may hold a card for a request that it has closed: its requester, with the
// hospital's name for the popup, and every user whose incoming list it can be in by
// getIncomingRequests' rules (compatible blood group, saved location within RADIUS_KM, no block
// with the requester), with only its id and why. Logged, never thrown: the request is already closed.
const announceReportedClose = async (closed) => {
  try {
    io.to(String(closed.requesterId)).emit('requestStatusUpdate', {
      requestId: closed._id,
      status: 'cancelled',
      reason: 'reported',
      hospitalName: closed.hospitalName,
    });

    const blockedUserIds = await findBlockedPairUserIds(closed.requesterId);
    const possibleViewers = await User.find({
      _id: { $nin: [closed.requesterId, ...blockedUserIds] },
      bloodGroup: { $in: getCompatibleDonorGroups(closed.bloodGroup) },
      location: {
        $geoWithin: { $centerSphere: [[...closed.hospitalLocation.coordinates], RADIUS_IN_RADIANS] },
      },
    })
      .select('_id')
      .lean();
    possibleViewers.forEach((viewer) => {
      io.to(String(viewer._id)).emit('requestStatusUpdate', {
        requestId: closed._id,
        status: 'cancelled',
        reason: 'reported',
      });
    });
  } catch (error) {
    console.error(`Closing reported request ${closed._id}: failed to tell those who see it:`, error.message);
  }
};

/**
 * Closes a request once REPORTS_TO_CLOSE_REQUEST different users whose accounts were created before
 * it have reported it, if it is still pending and inside its open hours: status 'cancelled' with
 * closedReason 'reported'. Reports from newer accounts are stored and hide the request from their
 * reporter, but do not count: accounts made after a request was posted, to report it, cannot close
 * it. One past its hours is left to expire instead, which keeps its "Post again". reportRequest
 * calls this after every report, a repeat included, so a close that failed once is tried again;
 * so does announceReopenedRequests (user.controller.js) for a request that a block or an account
 * deletion put back to pending.
 *
 * Race-safe with reports sent at once: each report is written before its count runs, so the count
 * that runs last sees all of them (the unique one_report_per_request index means each counts one
 * user), and neither a request's createdAt nor a user's ever changes. Several counts can reach the
 * number; the close is one conditional write, so only the first matches, and only that call sends
 * the events. The same holds against an accept, a cancel or the expiry sweep: whichever write
 * lands first wins.
 * @param {import('mongoose').Types.ObjectId | string} requestId
 * @returns {Promise<boolean>} whether this call closed it
 */
const closeRequestIfReported = async (requestId) => {
  const reporterIds = await Report.distinct('reporterId', { kind: 'request', requestId });
  if (reporterIds.length < REPORTS_TO_CLOSE_REQUEST) return false;
  const request = await Request.findById(requestId).select('createdAt').lean();
  if (!request) return false;
  const countingReporters = await User.countDocuments({
    _id: { $in: reporterIds },
    createdAt: { $lt: request.createdAt },
  });
  if (countingReporters < REPORTS_TO_CLOSE_REQUEST) return false;

  const closed = await Request.findOneAndUpdate(
    { _id: requestId, status: 'pending', ...stillOpenFilter() },
    { $set: { status: 'cancelled', closedReason: 'reported' } },
    { returnDocument: 'after' }
  );
  if (!closed) return false;

  await announceReportedClose(closed);
  return true;
};
exports.closeRequestIfReported = closeRequestIfReported;

// 403 like the other rules about the donor themselves (blood group, radius). The body carries
// the date too, so a client can show it without parsing the message.
const rejectInsideDonationGap = (res, nextEligibleDonationAt) =>
  res.status(403).json({ message: describeDonationGap(nextEligibleDonationAt), nextEligibleDonationAt });

// 409 like the other answers about a request that changed since the donor's list loaded, so the
// dashboard reloads it and the card goes
const rejectExpiredRequest = (res) => res.status(409).json({ message: 'This request has expired' });

// Every accept refused because the request is no longer open to this donor gets these same words:
// accepted by someone else, cancelled, fulfilled, closed after reports, changed during the accept,
// or a block between the donor and its requester. So a refusal never tells a donor they were
// blocked; the donor who blocked already knows.
const rejectUnavailableRequest = (res) => res.status(409).json({ message: 'This request is no longer available' });

/**
 * Puts back to pending a request this donor holds as accepted. The filter matches only while it is
 * still this donor's accept, so it never overwrites what happened to the request since.
 * asDeclined also adds the donor to declinedBy, as a decline would, so the request never reaches
 * them again (block.controller.js, when a block ends a match).
 * @returns {Promise<import('mongoose').Document | null>} the reopened request, or null if it no
 * longer was this donor's accept
 */
const reopenAcceptedRequest = (requestId, donorId, { asDeclined = false } = {}) =>
  Request.findOneAndUpdate(
    { _id: requestId, status: 'accepted', matchedDonorId: donorId },
    {
      $set: { status: 'pending', matchedDonorId: null },
      ...(asDeclined && { $addToSet: { declinedBy: donorId } }),
    },
    { returnDocument: 'after' }
  );
exports.reopenAcceptedRequest = reopenAcceptedRequest;

// Puts back to pending an accept that must not stand
const undoAccept = async (request, donor, reason) => {
  const reopened = await reopenAcceptedRequest(request._id, donor._id);
  if (!reopened) {
    // The requester cancelled or fulfilled it, or a deletion of this donor's account put it back
    // to pending, in the milliseconds since the write
    console.warn(`acceptRequest: accept of request ${request._id} by donor ${donor._id} ${reason} was not undone: it is no longer accepted by them`);
  }
};

const acceptRequest = async (req, res) => {
  const donor = req.user;
  const requestId = req.params.id;

  // The donation gap depends on the donor's OTHER documents (their fulfilled requests and their
  // own outside donation date), so it cannot be part of the single-document filter below. It is
  // checked here, so a donor inside the gap is refused without any write, and again after the
  // write for the one race this read can miss. req.user was read at the start of this request.
  const nextEligibleBeforeWrite = await findNextEligibleDonationAt(donor._id, donor.lastOutsideDonationDate);
  if (nextEligibleBeforeWrite) {
    return rejectInsideDonationGap(res, nextEligibleBeforeWrite);
  }

  // Blocks live in their own collection, so the filter below can only leave out the requesters
  // read here. A block made after this read is caught by the check after the write.
  const blockedUserIds = await findBlockedPairUserIds(donor._id);

  // One atomic write on one document, so no transaction is needed. The donor's User is not
  // written: holding this accepted request is what makes them busy (see createRequest).
  // Every rule about the request itself lives in the filter, so if two donors accept at the
  // same moment only the first can still match status: 'pending' and the other matches nothing.
  // The same holds against the expiry sweep, which also writes only while status is 'pending':
  // whichever write lands first wins, and createdAt keeps an accept out once the hours are up.
  let request;
  try {
    request = await Request.findOneAndUpdate(
      {
        _id: requestId,
        status: 'pending',
        ...stillOpenFilter(),
        requesterId: { $ne: donor._id, $nin: blockedUserIds },
        bloodGroup: { $in: getCompatibleRecipientGroups(donor.bloodGroup) },
        hospitalLocation: withinDonorRadius(donor),
      },
      { $set: { status: 'accepted', matchedDonorId: donor._id } },
      { returnDocument: 'after' }
    );
  } catch (error) {
    // The one_active_donation_per_donor unique index (request.model.js) rejected the write:
    // this donor already has an accepted request, even if both accepts were sent at once.
    if (error.code === 11000) {
      return res.status(409).json({
        message: 'You already have an active donation. Complete or wait for it to be cancelled before accepting another.',
      });
    }
    throw error;
  }

  if (!request) {
    // The write matched nothing: read the request to report which rule failed
    const existing = await Request.findById(requestId);
    if (!existing) {
      return res.status(404).json({ message: 'Request not found' });
    }
    // String(): requesterId is null on a fulfilled request whose requester deleted their account
    if (String(existing.requesterId) === String(donor._id)) {
      return res.status(403).json({ message: 'You cannot accept your own request' });
    }
    if (!isCompatibleDonor(donor.bloodGroup, existing.bloodGroup)) {
      return res.status(403).json({ message: 'Your blood group is not compatible with this request' });
    }
    const isWithinRadius = await Request.exists({
      _id: existing._id,
      hospitalLocation: withinDonorRadius(donor),
    });
    if (!isWithinRadius) {
      return res.status(403).json({
        message: `This request is outside your ${RADIUS_KM} km donation radius`,
      });
    }
    // The donor is eligible, so the request was no longer open to them: past its hours (whether or
    // not a sweep has closed it yet), no longer pending, or its requester is in a block with them
    if (hasExpired(existing)) {
      return rejectExpiredRequest(res);
    }
    const isAlreadyMatchedToDonor =
      existing.matchedDonorId && existing.matchedDonorId.toString() === donor._id.toString();
    if (existing.status === 'accepted' && isAlreadyMatchedToDonor) {
      return res.status(409).json({ message: 'You have already accepted this request' });
    }
    return rejectUnavailableRequest(res);
  }

  // Races the reads before the write cannot see, the first two checked on this one re-read of the
  // donor. Nothing has told the requester about the accept yet, so putting the request back to
  // pending undoes it.
  const freshDonor = await User.findById(donor._id).select('lastOutsideDonationDate').lean();

  // 1. protectRoute found the donor, but their account deletion (deleteAccount in
  // user.controller.js) can commit before this write lands, and after its own clean-up has run
  if (!freshDonor) {
    await undoAccept(request, donor, 'by a donor who no longer exists');
    return res.status(401).json({ message: 'Unauthorized - User not found' });
  }

  // 2. This donor's previous request is marked fulfilled AFTER the first gap check but BEFORE
  // the write above. The write could only succeed because that request had already left
  // 'accepted' (one_active_donation_per_donor), and a fulfil sets status and fulfilledAt in one
  // write, so this later read always sees the new donation. The outside date is re-read too, in
  // case the donor saved one meanwhile. This request is left out: if its requester has already
  // fulfilled it, the accept was valid, and the re-read below reports it.
  const nextEligibleAfterWrite = await findNextEligibleDonationAt(
    donor._id,
    freshDonor.lastOutsideDonationDate,
    { excludeRequestId: request._id }
  );
  if (nextEligibleAfterWrite) {
    await undoAccept(request, donor, 'inside the donation gap');
    return rejectInsideDonationGap(res, nextEligibleAfterWrite);
  }

  // 3. One of the two blocked the other after the read before the write. The block's own clean-up
  // (endMatchesAfterBlock in block.controller.js) starts only after the block is written, so if
  // this read misses the block, that clean-up finds this accept and ends it instead.
  if (await isBlockedPair(donor._id, request.requesterId)) {
    await undoAccept(request, donor, 'between users in a block');
    return rejectUnavailableRequest(res);
  }

  // A cancel or fulfil can still land between our write and this emit, so re-read to avoid
  // sending the requester a stale 'accepted'. Nothing else needs undoing: the accept wrote
  // only the request, and the cancel or fulfil already changed it.
  const current = await Request.findById(request._id).select('status matchedDonorId');
  const isStillMatched =
    current && current.status === 'accepted' && String(current.matchedDonorId) === String(donor._id);
  if (!isStillMatched) {
    return rejectUnavailableRequest(res);
  }

  // Emit status update back to the requester
  io.to(request.requesterId.toString()).emit('requestStatusUpdate', {
    requestId: request._id,
    status: request.status,
    donorName: donor.name,
  });

  return res.status(200).json({ message: 'Request status updated to accepted', request });
};

const declineRequest = async (req, res) => {
  const userId = req.user._id;
  const requestId = req.params.id;

  // $addToSet (not push) so declining twice does not duplicate the id.
  // Check matchedCount, not modifiedCount: a repeat decline must return 200 whatever
  // modifiedCount says (with timestamps: true it is 1 anyway, since updatedAt changes).
  // An expired request is refused like accept refuses it (409), not declined: it is closed, so a
  // decline would record nothing useful, and the 409 makes the dashboard reload and drop the card.
  const result = await Request.updateOne(
    { _id: requestId, status: 'pending', ...stillOpenFilter(), requesterId: { $ne: userId } },
    { $addToSet: { declinedBy: userId } }
  );

  if (result.matchedCount === 0) {
    const existing = await Request.findById(requestId);
    if (!existing) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (String(existing.requesterId) === String(userId)) {
      return res.status(403).json({ message: 'You cannot decline your own request' });
    }
    if (hasExpired(existing)) {
      return rejectExpiredRequest(res);
    }
    return res.status(409).json({ message: `This request is no longer pending (it has been ${existing.status})` });
  }

  // protectRoute found this user, but their account deletion (deleteAccount in
  // user.controller.js) can commit before this write lands, and after its own clean-up has run.
  // Checked after the write, as in createRequest, so their id is not left in declinedBy.
  if (!(await User.exists({ _id: userId }))) {
    await Request.updateOne({ _id: requestId }, { $pull: { declinedBy: userId } });
    console.warn(`declineRequest: user ${userId} no longer exists, so their decline of request ${requestId} was removed again`);
    return res.status(401).json({ message: 'Unauthorized - User not found' });
  }

  // Declining only hides the request from this donor; the global status is unchanged.
  // No request in the body: any logged-in user can call this, and the client ignores it.
  return res.status(200).json({ message: 'Request declined by you' });
};

const cancelRequest = async (req, res) => {
  const requester = req.user;
  const requestId = req.params.id;

  // Only the requester can cancel, and only while the request is still open. One atomic
  // write: leaving 'accepted' is what frees the donor, and their own isAvailable choice
  // is left exactly as they set it. A pending request past its open hours is not open any more,
  // even before a sweep has closed it, so it is not cancelled here (see below).
  const request = await Request.findOneAndUpdate(
    {
      _id: requestId,
      requesterId: requester._id,
      $or: [{ status: 'accepted' }, { status: 'pending', ...stillOpenFilter() }],
    },
    { $set: { status: 'cancelled' } },
    { returnDocument: 'after' }
  );

  if (!request) {
    const existing = await Request.findById(requestId);
    if (!existing) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (String(existing.requesterId) !== String(requester._id)) {
      return res.status(403).json({ message: 'Only the requester can cancel this request' });
    }
    if (hasExpired(existing)) {
      // Past its hours but not swept yet: closed as expired now, which sends the requester the
      // same event a sweep would. Logged, never thrown: the answer is 409 either way, since an
      // expired request is closed for every read and write whether or not it has been marked.
      if (existing.status === 'pending') {
        await expireStaleRequestsLogged({ scope: { _id: existing._id } });
      }
      return rejectExpiredRequest(res);
    }
    return res.status(409).json({ message: `This request has already been ${existing.status}` });
  }

  // Notify the donor only after the write has succeeded
  if (request.matchedDonorId) {
    io.to(request.matchedDonorId.toString()).emit('requestStatusUpdate', {
      requestId: request._id,
      status: 'cancelled',
      requesterName: requester.name,
    });
  }

  return res.status(200).json({ message: 'Request status updated to cancelled', request });
};

/**
 * POST /api/requests/:id/share-link: the token for the link to one of the caller's own open
 * requests (utils/shareToken.js). A request created before links existed has none, so the first
 * call makes it. Idempotent: every later call, including one at the same moment, gets that same
 * token. Only the requester, and only while the request is pending and inside its open hours,
 * the same rule the public page applies before it shows anything.
 */
exports.getShareLink = async (req, res) => {
  try {
    const requestId = req.params.id;
    const requesterId = req.user._id;

    // One atomic write that sets a token only where there is none. Of two calls at once, only one
    // can still match shareToken: { $exists: false }; the other matches nothing and reads below
    // the token the first one wrote.
    const created = await Request.findOneAndUpdate(
      {
        _id: requestId,
        requesterId,
        status: 'pending',
        ...stillOpenFilter(),
        shareToken: { $exists: false },
      },
      { $set: { shareToken: generateShareToken() } },
      { returnDocument: 'after' }
    ).select('shareToken');
    if (created) {
      return res.status(200).json({ shareToken: created.shareToken });
    }

    // The write matched nothing: the request already has a token, or a rule failed. Read it to
    // tell which, as the other routes do.
    const existing = await Request.findById(requestId).select('requesterId status closedReason createdAt shareToken');
    if (!existing) {
      return res.status(404).json({ message: 'Request not found' });
    }
    // String(): requesterId is null on a fulfilled request whose requester deleted their account
    if (String(existing.requesterId) !== String(requesterId)) {
      return res.status(403).json({ message: 'Only the requester can share this request' });
    }
    if (hasExpired(existing)) {
      // Past its hours but not swept yet: closed as expired now, as cancelRequest does, which
      // sends the requester the usual event. Logged, never thrown: the answer is 409 either way.
      if (existing.status === 'pending') {
        await expireStaleRequestsLogged({ scope: { _id: existing._id } });
      }
      return rejectExpiredRequest(res);
    }
    if (existing.status !== 'pending') {
      return res.status(409).json({ message: `Only an open request can be shared (this one has been ${existing.status})` });
    }
    if (!existing.shareToken) {
      // Pending, open and theirs, yet the write above matched nothing: it changed in between
      // (for example it was accepted and then reopened). Asking again settles it.
      return res.status(409).json({ message: 'This request changed while its link was being made. Please try again.' });
    }
    return res.status(200).json({ shareToken: existing.shareToken });
  } catch (error) {
    console.error('Error in getShareLink:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

/**
 * GET /api/public/requests/:token, for anyone, without an account (routes/public.route.js checks
 * the token's form first). Answers with the request's state and, only while it is open, the four
 * fields its requester's share text already holds, plus when it closes. Never a name, an id,
 * coordinates, declinedBy or any other date, whatever the state.
 */
exports.getSharedRequest = async (req, res) => {
  try {
    const request = await Request.findOne({ shareToken: req.params.token })
      .select('status closedReason createdAt bloodGroup unitsNeeded hospitalName urgency')
      .lean();
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    // Accepted requests never expire (utils/requestExpiry.js), so this one has a donor
    if (request.status === 'accepted') {
      return res.status(200).json({ state: 'donor_found' });
    }
    // Open: pending and inside its open hours, the rule every other read applies, whether or not
    // a sweep has closed it yet. Not swept from here: this route stays read-only for callers
    // without an account, and a requester's own reads close it for them.
    if (request.status === 'pending' && !hasExpired(request)) {
      return res.status(200).json({
        state: 'open',
        bloodGroup: request.bloodGroup,
        unitsNeeded: request.unitsNeeded,
        hospitalName: request.hospitalName,
        urgency: request.urgency,
        expiresAt: getRequestExpiresAt(request),
      });
    }
    // Fulfilled, cancelled, or expired
    return res.status(200).json({ state: 'closed' });
  } catch (error) {
    console.error('Error in getSharedRequest:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.updateRequestStatus = async (req, res) => {
  try {
    // updateRequestStatusSchema has already limited status to accepted | declined | cancelled
    const { status } = req.body;

    if (status === 'accepted') {
      return await acceptRequest(req, res);
    }
    if (status === 'declined') {
      return await declineRequest(req, res);
    }
    if (status === 'cancelled') {
      return await cancelRequest(req, res);
    }
    return res.status(400).json({ message: 'Invalid status' });
  } catch (error) {
    console.error('Error in updateRequestStatus:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.fulfillRequest = async (req, res) => {
  try {
    // The status filter is part of the write, so a fulfil cannot overwrite a cancel that
    // landed a moment earlier. One atomic write: leaving 'accepted' is what frees the donor,
    // and their own isAvailable choice is left exactly as they set it.
    const request = await Request.findOneAndUpdate(
      { _id: req.params.id, requesterId: req.user._id, status: 'accepted' },
      { $set: { status: 'fulfilled', fulfilledAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (!request) {
      // The write matched nothing: read the request to report which rule failed
      const existing = await Request.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: 'Request not found' });
      }

      // Only the original requester can mark as fulfilled
      if (String(existing.requesterId) !== String(req.user._id)) {
        return res.status(403).json({ message: 'Only the requester can mark this as fulfilled' });
      }

      return res.status(400).json({ message: 'Only accepted requests can be marked as fulfilled' });
    }

    // Notify the donor only after the write has succeeded. Inside the guard: the write has
    // already happened, so a null matchedDonorId must not turn a successful fulfil into a 500.
    if (request.matchedDonorId) {
      io.to(request.matchedDonorId.toString()).emit('requestStatusUpdate', {
        requestId: request._id,
        status: 'fulfilled',
        requesterName: req.user.name,
      });
    }

    res.status(200).json({ message: 'Request marked as fulfilled', request });
  } catch (error) {
    console.error('Error in fulfillRequest:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.rateRequest = async (req, res) => {
  try {
    const { rating, ratingNote } = req.body;

    // One atomic write with every rule in the filter, as in fulfillRequest. A read-then-save
    // could write the rating after the donor's account deletion had cleared the donation's
    // donor and rating note, and two ratings sent at once could both be saved.
    // runValidators: save() checked the rating's range and the note's length, so this does too.
    const request = await Request.findOneAndUpdate(
      {
        _id: req.params.id,
        requesterId: req.user._id,
        status: 'fulfilled',
        rating: null,
        matchedDonorId: { $ne: null },
      },
      { $set: { rating, ratingNote: ratingNote || '' } },
      { returnDocument: 'after', runValidators: true }
    );

    if (!request) {
      // The write matched nothing: read the request to report which rule failed
      const existing = await Request.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({ message: 'Request not found' });
      }

      // Only the original requester can rate
      if (String(existing.requesterId) !== String(req.user._id)) {
        return res.status(403).json({ message: 'Only the requester can rate this donation' });
      }

      if (existing.status !== 'fulfilled') {
        return res.status(400).json({ message: 'Only fulfilled requests can be rated' });
      }

      // 409 for the answers below: the request changed since the card was loaded (a rating from
      // another tab or device, or the donor's account deletion), so the dashboard reloads it
      if (existing.rating !== null) {
        return res.status(409).json({ message: 'This request has already been rated' });
      }

      // The donor deleted their account (deleteAccount in user.controller.js). A rating would count
      // towards no one, and its note would be about someone who asked to be erased.
      if (!existing.matchedDonorId) {
        return res.status(409).json({ message: 'The donor has deleted their account, so this donation can no longer be rated' });
      }

      // Every rule holds on this later read, so the request changed between the write and the
      // read (for example, it was marked fulfilled from another device in that moment)
      return res.status(409).json({ message: 'This request changed while it was being rated. Please try again.' });
    }

    // Notify the donor they received a rating
    if (request.matchedDonorId) {
      io.to(request.matchedDonorId.toString()).emit('requestStatusUpdate', {
        requestId: request._id,
        status: 'rated',
        rating,
        ratingNote: ratingNote || '',
        requesterName: req.user.name,
      });
    }

    res.status(200).json({ message: 'Rating submitted successfully', request });
  } catch (error) {
    console.error('Error in rateRequest:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
