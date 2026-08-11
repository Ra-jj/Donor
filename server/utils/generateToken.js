const jwt = require('jsonwebtoken');

const generateTokenAndSetCookie = (userId, res) => {
  // Generate a JWT signed with our secret
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });

  // Set the token as an HTTP-only cookie
  res.cookie('jwt', token, {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    httpOnly: true, // Prevents XSS attacks (not accessible via JavaScript)
    sameSite: 'strict', // Prevents CSRF attacks
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
  });

  return token;
};

module.exports = generateTokenAndSetCookie;
