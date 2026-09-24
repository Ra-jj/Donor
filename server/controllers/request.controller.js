const Request = require('../models/request.model');
const User = require('../models/user.model');
const { io } = require('../lib/socket');
const webpush = require('web-push');
const {
  isCompatibleDonor,
  getCompatibleDonorGroups,
  getCompatibleRecipientGroups,
} = require('../utils/bloodCompatibility');

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
    
    // Find all donors whose blood group is compatible with the requested blood group
    const compatibleDonorGroups = getCompatibleDonorGroups(bloodGroup);

    const matchedDonors = await User.find({
      _id: { $ne: requesterId }, // Exclude the requester themselves
      bloodGroup: { $in: compatibleDonorGroups }, 
      isAvailable: true,
      location: {
        $geoWithin: {
          $centerSphere: [hospitalLocation, radiusInRadians], // [ [lng, lat], radiusInRadians ]
        },
      },
    }).select('_id name email location bloodGroup pushSubscription');

    // 3. Emit real-time socket events and web push notifications to matched donors
    matchedDonors.forEach((donor) => {
      const isExactMatch = donor.bloodGroup === bloodGroup;
      const matchType = isExactMatch ? 'exact' : 'compatible';

      io.to(donor._id.toString()).emit('newBloodRequest', {
        ...newRequest.toObject(),
        requesterName: req.user.name,
        matchType,
      });

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
            User.findByIdAndUpdate(donor._id, { pushSubscription: null }).exec();
          }
        });
      }
    });

    res.status(201).json({
      message: 'Request created and donors matched successfully',
      request: newRequest,
      matchedDonors: matchedDonors.map((donor) => donor._id),
      matchedDonorDetails: matchedDonors, // Optional: helpful for testing/debugging
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
      .populate('requesterId', 'name profilePic')
      .sort({ createdAt: -1 });

    // Inject matchType tag before sending to client
    const incomingRequests = rawIncomingRequests.map(reqDoc => {
      const reqObj = reqDoc.toObject();
      if (reqObj.status === 'pending') {
        reqObj.matchType = (reqObj.bloodGroup === donor.bloodGroup) ? 'exact' : 'compatible';
      }
      return reqObj;
    });

    res.status(200).json({ incomingRequests });
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

  // Every eligibility rule lives in the filter of ONE atomic write. If two donors
  // accept at the same moment, only the first can still match status: 'pending'.
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
    // this donor already has an accepted request, even if both accepts were sent at once
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

  // Take the donor out of the matching pool until the request is fulfilled or cancelled
  await User.findByIdAndUpdate(donor._id, { isAvailable: false });

  // The requester can cancel (or fulfil) between the accept write and the write above. That
  // restores the donor BEFORE we mark them unavailable, leaving them stuck out of the pool,
  // and the requester would get a stale 'accepted' event. Re-check the match and undo.
  const current = await Request.findById(request._id).select('status matchedDonorId');
  const isStillMatched =
    current && current.status === 'accepted' && String(current.matchedDonorId) === String(donor._id);
  if (!isStillMatched) {
    await User.findByIdAndUpdate(donor._id, { isAvailable: true });
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

  // Only the requester can cancel, and only while the request is still open
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

  // Accepting marked the donor unavailable, so give them back to the matching pool
  if (request.matchedDonorId) {
    await User.findByIdAndUpdate(request.matchedDonorId, { isAvailable: true });

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
    // One atomic write, so a fulfil cannot overwrite a cancel that landed a moment earlier
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

    // Restore donor availability so they can accept future requests
    if (request.matchedDonorId) {
      await User.findByIdAndUpdate(request.matchedDonorId, { isAvailable: true });

      // Notify the donor in real-time (inside the guard: the write has already committed,
      // so a null matchedDonorId must not turn a successful fulfil into a 500)
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
