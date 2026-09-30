const Request = require('../models/request.model');
const User = require('../models/user.model');
const { io } = require('../lib/socket');
const webpush = require('web-push');
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

// Configure web-push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@donorapp.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const RADIUS_KM = 15;
const EARTH_RADIUS_KM = 6378.1;

// IMPORTANT: $centerSphere takes radius in radians.
// To convert km to radians, divide distance by Earth's radius (6378.1 km).
const RADIUS_IN_RADIANS = RADIUS_KM / EARTH_RADIUS_KM;
// Wider, so the same query also returns every donor whose ROUNDED point is within RADIUS_KM
const CANDIDATE_RADIUS_IN_RADIANS = (RADIUS_KM + PIN_CANDIDATE_MARGIN_KM) / EARTH_RADIUS_KM;

/**
 * Geospatial query for the donors a pending request may reach, over the wider candidate radius.
 * Leaves out busy and resting donors, the requester, and every donor who declined the request.
 * @param {import('mongoose').Document} request - a saved Request document
 */
const findCandidateDonors = async (request) => {
  // Find all donors whose blood group is compatible with the requested blood group
  const compatibleDonorGroups = getCompatibleDonorGroups(request.bloodGroup);

  // Busy donors already hold an accepted request, so they are left out even when their own
  // isAvailable choice is true. one_active_donation_per_donor keeps this to one per donor.
  // Donors inside the minimum gap after a donation are left out the same way: those who
  // donated through the app here, those who reported an outside donation in the User filter.
  const donationGapCutoff = getDonationGapCutoff();
  const unavailableDonorIds = await Request.distinct('matchedDonorId', {
    $or: [{ status: 'accepted' }, inAppDonationInGapFilter(donationGapCutoff)],
  });

  // One query over the wider radius; both donor lists in createRequest are filtered from it in
  // JS, so leaving busy and resting donors out here keeps them out of the notify list AND the
  // count and pins. Select only what the callers use: _id for the socket room, bloodGroup for
  // exact vs compatible, pushSubscription for the push, and location for the two distance checks.
  // declinedBy is always empty on a new request; a reopened one keeps the donors who said no.
  return User.find({
    // Exclude busy or resting donors, the requester, and donors who declined
    _id: { $nin: [...unavailableDonorIds, request.requesterId, ...request.declinedBy] },
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
          body: `${requesterName} needs ${unitsNeeded} units of ${bloodGroup} at ${hospitalName}. ${isExactMatch ? 'You are an exact match!' : 'You are a compatible match!'}`,
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
      request: newRequest,
      // Any logged-in user can create a request anywhere, so only a count and ~1.1 km pins
      // go back: no donor ids, names, emails, blood groups, push data or exact coordinates.
      matchedDonorCount: visibleDonorPoints.length,
      donorPins: buildDonorPins(visibleDonorPoints),
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

    // Find pending requests nearby matching compatible blood groups, OR requests this donor has already accepted
    const rawIncomingRequests = await Request.find({
      $or: [
        {
          status: 'pending',
          bloodGroup: { $in: compatibleRecipientGroups },
          requesterId: { $ne: donor._id },
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

// 403 like the other rules about the donor themselves (blood group, radius). The body carries
// the date too, so a client can show it without parsing the message.
const rejectInsideDonationGap = (res, nextEligibleDonationAt) =>
  res.status(403).json({ message: describeDonationGap(nextEligibleDonationAt), nextEligibleDonationAt });

// Puts back to pending an accept that must not stand. The filter matches only while it is still
// this donor's accept, so it never overwrites what happened to the request since.
const undoAccept = async (request, donor, reason) => {
  const undo = await Request.updateOne(
    { _id: request._id, status: 'accepted', matchedDonorId: donor._id },
    { $set: { status: 'pending', matchedDonorId: null } }
  );
  if (undo.matchedCount === 0) {
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

  // One atomic write on one document, so no transaction is needed. The donor's User is not
  // written: holding this accepted request is what makes them busy (see createRequest).
  // Every rule about the request itself lives in the filter, so if two donors accept at the
  // same moment only the first can still match status: 'pending' and the other matches nothing.
  let request;
  try {
    request = await Request.findOneAndUpdate(
      {
        _id: requestId,
        status: 'pending',
        requesterId: { $ne: donor._id },
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

    // The donor is eligible, so the request was no longer pending
    const isAlreadyMatchedToDonor =
      existing.matchedDonorId && existing.matchedDonorId.toString() === donor._id.toString();
    if (existing.status === 'accepted' && isAlreadyMatchedToDonor) {
      return res.status(409).json({ message: 'You have already accepted this request' });
    }
    if (existing.status === 'accepted') {
      return res.status(409).json({ message: 'This request has already been accepted by another donor' });
    }
    return res.status(409).json({ message: `This request is no longer pending (it has been ${existing.status})` });
  }

  // Two races the reads before the write cannot see, both checked on this one re-read of the
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

  // A cancel or fulfil can still land between our write and this emit, so re-read to avoid
  // sending the requester a stale 'accepted'. Nothing else needs undoing: the accept wrote
  // only the request, and the cancel or fulfil already changed it.
  const current = await Request.findById(request._id).select('status matchedDonorId');
  const isStillMatched =
    current && current.status === 'accepted' && String(current.matchedDonorId) === String(donor._id);
  if (!isStillMatched) {
    return res.status(409).json({
      message: `This request has already been ${current ? current.status : 'removed'}`,
    });
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
  const result = await Request.updateOne(
    { _id: requestId, status: 'pending', requesterId: { $ne: userId } },
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
  // is left exactly as they set it.
  const request = await Request.findOneAndUpdate(
    {
      _id: requestId,
      requesterId: requester._id,
      status: { $in: ['pending', 'accepted'] },
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
