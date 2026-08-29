const Request = require('../models/request.model');
const User = require('../models/user.model');
const { io } = require('../lib/socket');
const webpush = require('web-push');

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

    const matchedDonors = await User.find({
      _id: { $ne: requesterId }, // Exclude the requester themselves
      bloodGroup: bloodGroup, // Exact match for MVP
      isAvailable: true,
      location: {
        $geoWithin: {
          $centerSphere: [hospitalLocation, radiusInRadians], // [ [lng, lat], radiusInRadians ]
        },
      },
    }).select('_id name email location pushSubscription');

    // 3. Emit real-time socket events and web push notifications to matched donors
    matchedDonors.forEach((donor) => {
      io.to(donor._id.toString()).emit('newBloodRequest', {
        ...newRequest.toObject(),
        requesterName: req.user.name,
      });

      // Send Web Push Notification if the donor is subscribed
      if (donor.pushSubscription) {
        const payload = JSON.stringify({
          title: '🚨 Emergency Blood Request!',
          body: `${req.user.name} needs ${unitsNeeded} units of ${bloodGroup} at ${hospitalName}. Can you help?`,
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

    // Find pending requests nearby matching donor's blood group, OR requests this donor has already accepted
    const incomingRequests = await Request.find({
      $or: [
        {
          status: 'pending',
          bloodGroup: donor.bloodGroup,
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
          status: 'accepted'
        }
      ]
    })
      .populate('requesterId', 'name profilePic')
      .sort({ createdAt: -1 });

    res.status(200).json({ incomingRequests });
  } catch (error) {
    console.error('Error in getIncomingRequests:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.updateRequestStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const requestId = req.params.id;

    if (!['accepted', 'declined', 'fulfilled', 'cancelled'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const request = await Request.findById(requestId);
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    // If a donor accepts, we set them as the matchedDonorId and change status
    if (status === 'accepted' && request.status === 'pending') {
      request.status = 'accepted';
      request.matchedDonorId = req.user._id;
      
      // Update donor availability (optional based on preference, but good practice)
      await User.findByIdAndUpdate(req.user._id, { isAvailable: false });
    } else if (status === 'declined') {
      // Just hide it from this donor, don't change global status
      request.declinedBy.push(req.user._id);
      await request.save();
      return res.status(200).json({ message: 'Request declined by you', request });
    } else if (status === 'cancelled' || status === 'fulfilled') {
      // Just update the status if authorized (authorization logic can be more strict here)
      request.status = status;
    }

    await request.save();

    // Emit status update back to the requester
    io.to(request.requesterId.toString()).emit('requestStatusUpdate', {
      requestId: request._id,
      status: request.status,
      donorName: req.user.name,
    });

    res.status(200).json({ message: `Request status updated to ${status}`, request });
  } catch (error) {
    console.error('Error in updateRequestStatus:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
