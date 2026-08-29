const express = require('express');
const router = express.Router();
const User = require('../models/user.model');
const protectRoute = require('../middleware/auth.middleware');

// Save the push subscription for the logged-in user
router.post('/subscribe', protectRoute, async (req, res) => {
  try {
    const subscription = req.body;
    
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ message: 'Invalid subscription object' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.pushSubscription = subscription;
    await user.save();

    res.status(200).json({ message: 'Push subscription saved successfully' });
  } catch (error) {
    console.error('Error in /subscribe:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// Remove the push subscription
router.post('/unsubscribe', protectRoute, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.pushSubscription = null;
    await user.save();

    res.status(200).json({ message: 'Push subscription removed successfully' });
  } catch (error) {
    console.error('Error in /unsubscribe:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

module.exports = router;
