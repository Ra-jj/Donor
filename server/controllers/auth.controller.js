const bcrypt = require('bcrypt');
const User = require('../models/user.model');
const generateTokenAndSetCookie = require('../utils/generateToken');

exports.register = async (req, res) => {
  try {
    const { name, email, password, bloodGroup, location } = req.body;

    // Basic validation
    if (!name || !email || !password || !bloodGroup || !location) {
      return res.status(400).json({ message: 'All fields are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    // Check for existing user
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email is already registered.' });
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
    });

    await newUser.save();

    // Generate token & cookie
    generateTokenAndSetCookie(newUser._id, res);

    // Exclude password from the response
    const userResponse = newUser.toObject();
    delete userResponse.password;

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

    // Generate token & cookie
    generateTokenAndSetCookie(user._id, res);

    const userResponse = user.toObject();
    delete userResponse.password;

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
    res.cookie('jwt', '', { maxAge: 0 });
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error in logout controller:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.checkAuth = async (req, res) => {
  try {
    // req.user is attached by the protectRoute middleware
    res.status(200).json({ user: req.user });
  } catch (error) {
    console.error('Error in checkAuth controller:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
