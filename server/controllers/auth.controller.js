const bcrypt = require('bcrypt');
const User = require('../models/user.model');
const generateTokenAndSetCookie = require('../utils/generateToken');
const { AUTH_COOKIE_NAME, getAuthCookieOptions } = require('../utils/authCookie');
const { withDonationEligibility } = require('../utils/donationGap');
const { buildSignUpPrivacyConsentFields } = require('../utils/privacyConsent');

const EMAIL_TAKEN_MESSAGE = 'Email is already registered.';

// MongoDB's answer when a save hits the unique index on email. Its message and keyValue hold the
// email address, so neither may be logged.
const isDuplicateEmailError = (error) => error?.code === 11000 && Boolean(error.keyPattern?.email);

exports.register = async (req, res) => {
  try {
    const { name, email, password, bloodGroup, location, acceptPrivacy, confirmAdult } = req.body;

    // Basic validation
    if (!name || !email || !password || !bloodGroup || !location) {
      return res.status(400).json({ message: 'All fields are required.' });
    }
    // registerSchema already refuses anything but true; checked here too because the account
    // below records these two agreements as given
    if (acceptPrivacy !== true || confirmAdult !== true) {
      return res.status(400).json({ message: 'Agree to the Privacy Notice and confirm you are 18 or older.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    // Check for existing user
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: EMAIL_TAKEN_MESSAGE });
    }

    // Hash the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create the new user
    const newUser = new User({
      name,
      email,
      password: hashedPassword,
      bloodGroup,
      location: {
        type: 'Point',
        coordinates: location, // Ensure frontend sends this as [lng, lat]
      },
      // The current notice version and the server's time, never values from the request body,
      // with the consent history's first entry
      ...buildSignUpPrivacyConsentFields(),
    });

    try {
      await newUser.save();
    } catch (error) {
      // Another sign-up with the same email was saved after the check above (two at once), and
      // the unique index refused this one: the same answer as the check, and no 500
      if (isDuplicateEmailError(error)) {
        console.warn(`register: save refused by the unique email index (error code ${error.code})`);
        return res.status(400).json({ message: EMAIL_TAKEN_MESSAGE });
      }
      throw error;
    }

    // No password; nextEligibleDonationAt as in every user response (null for a new account).
    // Built before the cookie is set, so a failure here does not leave a half-done sign-in.
    const userResponse = await withDonationEligibility(newUser);

    // Generate token & cookie
    generateTokenAndSetCookie(newUser._id, res);

    res.status(201).json({
      message: 'User registered successfully',
      user: userResponse,
    });
  } catch (error) {
    console.error('Error in register controller:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate inputs
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials.' });
    }

    // Compare passwords
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials.' });
    }

    // No password, plus when this donor may donate again (the client keeps it on authUser).
    // Built before the cookie is set, so a failure here does not leave a half-done sign-in.
    const userResponse = await withDonationEligibility(user);

    // Generate token & cookie
    generateTokenAndSetCookie(user._id, res);

    res.status(200).json({
      message: 'Logged in successfully',
      user: userResponse,
    });
  } catch (error) {
    console.error('Error in login controller:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.logout = (req, res) => {
  try {
    // Same attributes as the login cookie, so the browser matches and removes it
    res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions());
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error in logout controller:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.checkAuth = async (req, res) => {
  try {
    // req.user is attached by the protectRoute middleware (without the password). The client's
    // authUser comes from here, so it also carries when this donor may donate again.
    res.status(200).json({ user: await withDonationEligibility(req.user) });
  } catch (error) {
    console.error('Error in checkAuth controller:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
