const jwt = require('jsonwebtoken');
const { AUTH_COOKIE_NAME, getAuthCookieOptions } = require('./authCookie');

const generateTokenAndSetCookie = (userId, res) => {
  // Generate a JWT signed with our secret
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });

  res.cookie(AUTH_COOKIE_NAME, token, {
    ...getAuthCookieOptions(),
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds, same as the token's expiresIn
  });

  return token;
};

module.exports = generateTokenAndSetCookie;
