const Request = require('../models/request.model');
const User = require('../models/user.model');

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
    const { name, bloodGroup, location, isAvailable } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (bloodGroup !== undefined) updates.bloodGroup = bloodGroup;
    if (isAvailable !== undefined) updates.isAvailable = isAvailable;
    if (location !== undefined) {
      updates.location = {
        type: 'Point',
        coordinates: location,
      };
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updates, {
      new: true,
      select: '-password',
    });

    res.status(200).json({ user: updatedUser });
  } catch (error) {
    console.error('Error in updateProfile:', error.message);
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
