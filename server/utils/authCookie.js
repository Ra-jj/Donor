const AUTH_COOKIE_NAME = 'jwt';

// Shared by login (res.cookie) and logout (res.clearCookie). A browser only removes a cookie
// when the clearing Set-Cookie matches the original's attributes, so both must use these.
// Read at call time so NODE_ENV is taken as it is when the response is sent.
const getAuthCookieOptions = () => ({
  httpOnly: true, // not readable from JavaScript
  sameSite: 'strict', // not sent on cross-site requests
  secure: process.env.NODE_ENV === 'production', // HTTPS only in production
});

module.exports = { AUTH_COOKIE_NAME, getAuthCookieOptions };
