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

    // 2. Geospatial query to find matching donors
    // IMPORTANT: $centerSphere takes radius in radians.
    // To convert km to radians, divide distance by Earth's radius (6378.1 km).
    const radiusInRadians = RADIUS_KM / EARTH_RADIUS_KM;
    // Wider, so the same query also returns every donor whose ROUNDED point is within RADIUS_KM
    const candidateRadiusInRadians = (RADIUS_KM + PIN_CANDIDATE_MARGIN_KM) / EARTH_RADIUS_KM;

    // Find all donors whose blood group is compatible with the requested blood group
    const compatibleDonorGroups = getCompatibleDonorGroups(bloodGroup);

    // Busy donors already hold an accepted request, so they are left out even when their own
    // isAvailable choice is true. one_active_donation_per_donor keeps this to one per donor.
    const busyDonorIds = await Request.distinct('matchedDonorId', { status: 'accepted' });

    // One query over the wider radius; both donor lists below are filtered from it in JS, so
    // leaving busy donors out here keeps them out of the notify list AND the count and pins.
    // Select only what this handler uses: _id for the socket room, bloodGroup for exact vs
    // compatible, pushSubscription for the push, and location for the two distance checks.
    const candidateDonors = await User.find({
      _id: { $nin: [...busyDonorIds, requesterId] }, // Exclude busy donors and the requester
      bloodGroup: { $in: compatibleDonorGroups },
      isAvailable: true,
      location: {
        $geoWithin: {
          $centerSphere: [hospitalLocation, candidateRadiusInRadians], // [ [lng, lat], radiusInRadians ]
        },
      },
    }).select('_id bloodGroup pushSubscription location');

    // Donors to notify: EXACT home within RADIUS_KM, the rule the $centerSphere query applied
    // before (same spherical model, same radius in radians)
    const donorsToNotify = candidateDonors.filter(
      (donor) => angularDistanceRadians(hospitalLocation, donor.location.coordinates) <= radiusInRadians
    );

    // What the requester sees depends ONLY on rounded homes. If the count used exact homes,
    // a requester could move the hospital point until a donor drops out of the count and so
    // binary-search the 15 km edge down to that donor's exact home.
    // Accepted inaccuracy: near the edge, the count and pins can differ slightly from who was
    // notified (a donor just outside may be counted, one just inside may not). The UI only
    // says "compatible donors near", so that is fine.
    const visibleDonorPoints = candidateDonors
      .map((donor) => roundCoordinatePair(donor.location.coordinates))
      .filter((point) => point && angularDistanceRadians(hospitalLocation, point) <= radiusInRadians);

    // The newBloodRequest payload: only the fields the donor's incoming card reads, so no
    // requesterId or other user ids. Built before the 201 so a failure here is still a 500.
    const savedRequest = newRequest.toObject();
    const requestForDonors = {
      _id: savedRequest._id,
      bloodGroup: savedRequest.bloodGroup,
      unitsNeeded: savedRequest.unitsNeeded,
      hospitalName: savedRequest.hospitalName,
      hospitalLocation: savedRequest.hospitalLocation,
      urgency: savedRequest.urgency,
      status: savedRequest.status,
      createdAt: savedRequest.createdAt,
      requesterName: req.user.name,
    };

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
    // A try/catch per donor: the 201 has already been sent (the outer catch would try a 500),
    // and one failing donor must not stop the rest from being notified.
    donorsToNotify.forEach((donor) => {
      try {
        const isExactMatch = donor.bloodGroup === bloodGroup;
        const matchType = isExactMatch ? 'exact' : 'compatible';

        io.to(donor._id.toString()).emit('newBloodRequest', { ...requestForDonors, matchType });

        // Send Web Push Notification if the donor is subscribed
        if (donor.pushSubscription) {
          const payload = JSON.stringify({
            title: '🚨 Emergency Blood Request!',
            body: `${req.user.name} needs ${unitsNeeded} units of ${bloodGroup} at ${hospitalName}. ${isExactMatch ? 'You are an exact match!' : 'You are a compatible match!'}`,
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

    res.status(200).json({ incomingRequests, hasActiveDonation });
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

const acceptRequest = async (req, res) => {
  const donor = req.user;
  const requestId = req.params.id;

  // One atomic write on one document, so no transaction is needed. The donor's User is not
  // written: holding this accepted request is what makes them busy (see createRequest).
  // Every eligibility rule lives in the filter, so if two donors accept at the same moment
  // only the first can still match status: 'pending' and the other matches nothing.
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
    if (existing.requesterId.toString() === donor._id.toString()) {
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
    if (existing.requesterId.toString() === userId.toString()) {
      return res.status(403).json({ message: 'You cannot decline your own request' });
    }
    return res.status(409).json({ message: `This request is no longer pending (it has been ${existing.status})` });
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
    if (existing.requesterId.toString() !== requester._id.toString()) {
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
      if (existing.requesterId.toString() !== req.user._id.toString()) {
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
    const request = await Request.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    // Only the original requester can rate
    if (request.requesterId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Only the requester can rate this donation' });
    }

    if (request.status !== 'fulfilled') {
      return res.status(400).json({ message: 'Only fulfilled requests can be rated' });
    }

    if (request.rating !== null) {
      return res.status(400).json({ message: 'This request has already been rated' });
    }

    const { rating, ratingNote } = req.body;
    request.rating = rating;
    request.ratingNote = ratingNote || '';
    await request.save();

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
