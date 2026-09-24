const express = require('express');
const router = express.Router();
const User = require('../models/user.model');
const protectRoute = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const { pushSubscriptionSchema } = require('../validators/pushValidator');

// Save the push subscription for the logged-in user. validate() has already checked the
// endpoint host against the push-service allowlist and the key lengths.
router.post('/subscribe', protectRoute, validate(pushSubscriptionSchema), async (req, res) => {
  try {
    // Only the validated fields are stored, never the raw request body
    const { endpoint, expirationTime, keys } = req.body;
    const subscription = {
      endpoint,
      expirationTime: expirationTime ?? null,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    };

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
